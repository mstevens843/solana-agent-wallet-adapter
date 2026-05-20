import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecurringScheduleRecord } from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

import type { DevApiHandler, DevApiHandlerContext } from '../cloud/devApiRegistry.js';
import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import type { RecurringStore } from '../cloud/recurringService.js';
import type { Clock } from '../cloud/store.js';
import { WorkflowService } from '../cloud/workflowService.js';

type SkillManifest = DevLayer1.skills.SkillManifest;
type SkillCaps = DevLayer1.skills.SkillCaps;
type SkillInstallRecord = DevLayer1.skills.SkillInstallRecord;
type SkillExecutionRecord = DevLayer1.skills.SkillExecutionRecord;

interface SkillInstallListRow {
  install: SkillInstallRecord;
  manifest?: SkillManifest;
  recentExecutionCount: number;
  lastExecutionAt?: string;
  nextRunAt?: string;
  recurringScheduleStatus?: string;
}

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';
const AUTHOR_WALLET = '6PzC4tnRy18p7mePR5J6BG5T2qSF6RcwGsbtkjVxg5Vt';
const FIXED_NOW = new Date('2026-05-14T12:00:00.000Z');

const ENV_KEYS = [
  'AGENTIC_DEV_AP2_ACP',
  'AGENTIC_DEV_WALLET_ALLOWLIST',
  'TREASURY_WALLET',
  'PLATFORM_FEE_BPS',
  'SKR_TOKEN_MINT',
  'SKR_TOKEN_DECIMALS',
  'SKR_SKILL_BOUNTY_ACTIVE',
  'SKR_SESSION_DEFAULT',
] as const;

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

interface TestResponse {
  status: number;
  body: Record<string, unknown> | null;
  rawBody: string;
  headers: IncomingHttpHeaders;
}

interface DevGateModule {
  isAllowedDevWallet: (walletAddress: string | undefined | null) => boolean;
  devLayer1Enabled: () => boolean;
}

interface RegistryModule {
  listDevApiHandlers: () => readonly DevApiHandler[];
  clearDevApiHandlersForTesting: () => void;
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

function setEnv(env: EnvSnapshot): void {
  for (const [key, value] of Object.entries(env) as Array<[(typeof ENV_KEYS)[number], string | undefined]>) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

interface SkillsTestServer {
  port: number;
  workflowStore: MemoryWorkflowStore;
  evidenceStore: MemoryEvidenceStore;
  workflowService: WorkflowService;
  clock: Clock;
  recurringStoreFor: (store: MemoryWorkflowStore) => RecurringStore;
}

async function loadFreshSkillsRoutes(
  opts: { launchSkills?: readonly SkillManifest[] } = {},
): Promise<{
  handlers: readonly DevApiHandler[];
  gate: DevGateModule;
  recurringStoreFor: (store: MemoryWorkflowStore) => RecurringStore;
}> {
  vi.resetModules();
  vi.doMock('@solana-agent-wallet-adapter/launch-skills', () => ({
    LAUNCH_SKILLS: opts.launchSkills ?? [],
  }));
  const registry = (await import('../cloud/devApiRegistry.js')) as RegistryModule;
  registry.clearDevApiHandlersForTesting();
  await import('../cloud/skillsRoutes.js');
  const gate = (await import('../cloud/devGate.js')) as DevGateModule;
  const recurringRoutes = (await import('../cloud/recurringRoutes.js')) as {
    recurringStoreAdapterForCloudStore: (store: MemoryWorkflowStore) => RecurringStore;
  };
  return {
    handlers: registry.listDevApiHandlers(),
    gate,
    recurringStoreFor: recurringRoutes.recurringStoreAdapterForCloudStore,
  };
}

async function withSkillsServer(
  env: EnvSnapshot,
  callback: (server: SkillsTestServer) => Promise<void>,
  options: { launchSkills?: readonly SkillManifest[] } = {},
): Promise<void> {
  setEnv(env);
  const { handlers, gate, recurringStoreFor } = await loadFreshSkillsRoutes(options);
  const workflowStore = new MemoryWorkflowStore();
  const evidenceStore = new MemoryEvidenceStore();
  const clock: Clock = { now: () => FIXED_NOW };
  const workflowService = new WorkflowService(workflowStore, { clock: () => FIXED_NOW });

  const server = createServer((req, res) => {
    void dispatch(req, res, {
      handlers,
      gate,
      workflowStore,
      evidenceStore,
      workflowService,
      clock,
    });
  });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback({
      port: address.port,
      workflowStore,
      evidenceStore,
      workflowService,
      clock,
      recurringStoreFor,
    });
  } finally {
    await close(server);
    vi.doUnmock('@solana-agent-wallet-adapter/launch-skills');
  }
}

interface DispatchDeps {
  handlers: readonly DevApiHandler[];
  gate: DevGateModule;
  workflowStore: MemoryWorkflowStore;
  evidenceStore: MemoryEvidenceStore;
  workflowService: WorkflowService;
  clock: Clock;
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  // Prefer longest prefix match so /api/skills/installs beats /api/skills.
  const handler = deps.handlers
    .filter((h) => url.pathname.startsWith(h.prefix) && h.methods.includes(method))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  let walletAddress: string | undefined;
  if (!handler.publicRoute) {
    if (!deps.gate.devLayer1Enabled()) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'dev_layer1_disabled' }));
      return;
    }
    const headerWallet = req.headers['x-test-wallet'];
    walletAddress = typeof headerWallet === 'string' ? headerWallet : undefined;
    if (!deps.gate.isAllowedDevWallet(walletAddress)) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'dev_layer1_disabled' }));
      return;
    }
  }
  const context: DevApiHandlerContext = {
    walletAddress,
    workflowService: deps.workflowService,
    workflowStore: deps.workflowStore,
    evidenceStore: deps.evidenceStore,
    clock: deps.clock,
  };
  try {
    await handler.handle(req, res, url, context);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'internal_error', message: err instanceof Error ? err.message : 'unknown' }));
    }
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

async function rawRequest(
  port: number,
  method: string,
  path: string,
  options: { wallet?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    };
    if (options.wallet) headers['x-test-wallet'] = options.wallet;
    const req = httpRequest(
      {
        method,
        host: '127.0.0.1',
        port,
        path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown> | null = null;
          if (rawBody.length > 0) {
            try {
              body = JSON.parse(rawBody);
            } catch {
              body = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, body, rawBody, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (options.rawBody !== undefined) {
      req.write(options.rawBody);
    } else if (options.body !== undefined) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

function getJson(port: number, path: string, wallet?: string): Promise<TestResponse> {
  return rawRequest(port, 'GET', path, wallet ? { wallet } : {});
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  wallet?: string,
  extraHeaders?: Record<string, string>,
): Promise<TestResponse> {
  const options: { wallet?: string; body?: unknown; headers?: Record<string, string> } = { body };
  if (wallet) options.wallet = wallet;
  if (extraHeaders) options.headers = extraHeaders;
  return rawRequest(port, 'POST', path, options);
}

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    authorWallet: AUTHOR_WALLET,
    description: 'Test skill for unit tests',
    category: 'dca',
    schedule: { kind: 'cron', spec: '0 14 * * 5' },
    action: {
      connectorAction: 'prepare_swap',
      paramsTemplate: { inputMint: 'USDC', outputMint: 'SOL', amount: '50' },
    },
    caps: {
      perRunMaxAmount: '50',
      lifetimeMaxAmount: '2600',
      allowlistedTokens: ['USDC', 'SOL'],
      expiresAt: '2027-12-31T23:59:59.000Z',
      maxExecutions: 52,
    },
    ...overrides,
  };
}

function defaultCaps(overrides: Partial<SkillCaps> = {}): SkillCaps {
  return {
    perRunMaxAmount: '25',
    lifetimeMaxAmount: '1300',
    allowlistedTokens: ['SOL'],
    ...overrides,
  };
}

const DEFAULT_ENV: EnvSnapshot = {
  AGENTIC_DEV_AP2_ACP: '1',
  AGENTIC_DEV_WALLET_ALLOWLIST: DEV_WALLET,
};

const AUTHOR_ENV: EnvSnapshot = {
  AGENTIC_DEV_AP2_ACP: '1',
  AGENTIC_DEV_WALLET_ALLOWLIST: `${DEV_WALLET},${AUTHOR_WALLET}`,
};

async function seedManifest(store: MemoryWorkflowStore, manifest: SkillManifest): Promise<void> {
  await store.saveSkillManifest({
    id: manifest.id,
    version: manifest.version,
    authorWallet: manifest.authorWallet,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    manifest,
  });
}

function makeRecurringSchedule(
  overrides: Partial<RecurringScheduleRecord> = {},
): RecurringScheduleRecord {
  return {
    id: overrides.id ?? 'recurring_test',
    status: overrides.status ?? 'active',
    walletAddress: overrides.walletAddress ?? DEV_WALLET,
    cluster: overrides.cluster ?? 'mainnet-beta',
    token: overrides.token ?? 'USDC',
    recipient: overrides.recipient ?? AUTHOR_WALLET,
    amount: overrides.amount ?? '5',
    cadence: overrides.cadence ?? 'monthly',
    createdAt: overrides.createdAt ?? FIXED_NOW.toISOString(),
    updatedAt: overrides.updatedAt ?? FIXED_NOW.toISOString(),
    dayOfMonth: overrides.dayOfMonth ?? 14,
    localTime: overrides.localTime ?? '12:00',
    occurrencesCreated: overrides.occurrencesCreated ?? 0,
    metadata: overrides.metadata ?? {
      source: 'skill_install_monetization',
      skillInstallId: 'skill_install_test',
      skillId: 'friday-dca',
      monetizationKind: 'monthly',
    },
    ...overrides,
  };
}

describe('skillsRoutes API', () => {
  let original: EnvSnapshot;
  beforeEach(() => {
    original = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv(original);
  });

  describe('dev gate', () => {
    it('returns 403 without a wallet header', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await getJson(port, '/api/skills');
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'dev_layer1_disabled' });
      });
    });

    it('returns 403 when wallet is not in the allowlist', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await getJson(port, '/api/skills', OTHER_WALLET);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'dev_layer1_disabled' });
      });
    });

    it('returns 403 when AGENTIC_DEV_AP2_ACP is disabled', async () => {
      await withSkillsServer(
        { ...DEFAULT_ENV, AGENTIC_DEV_AP2_ACP: '0' },
        async ({ port }) => {
          const res = await getJson(port, '/api/skills', DEV_WALLET);
          expect(res.status).toBe(403);
          expect(res.body).toEqual({ error: 'dev_layer1_disabled' });
        },
      );
    });
  });

  describe('GET /api/skills (catalog)', () => {
    it('returns an empty catalog when no manifests and no LAUNCH_SKILLS', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await getJson(port, '/api/skills', DEV_WALLET);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ skills: [], treasuryActive: false, platformFeeBps: 0 });
      });
    });

    it('surfaces treasury config in the catalog response when TREASURY_WALLET is set', async () => {
      await withSkillsServer(
        { ...DEFAULT_ENV, TREASURY_WALLET: DEV_WALLET, PLATFORM_FEE_BPS: '1500' },
        async ({ port }) => {
          const res = await getJson(port, '/api/skills', DEV_WALLET);
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({ treasuryActive: true, platformFeeBps: 1500 });
        },
      );
    });

    it('lazy-seeds LAUNCH_SKILLS on first GET', async () => {
      const seedManifest = makeManifest({ id: 'seed-skill', name: 'Seed' });
      await withSkillsServer(
        DEFAULT_ENV,
        async ({ port, workflowStore, recurringStoreFor }) => {
          const res = await getJson(port, '/api/skills', DEV_WALLET);
          expect(res.status).toBe(200);
          const body = res.body as { skills: SkillManifest[] };
          expect(body.skills).toHaveLength(1);
          expect(body.skills[0]?.id).toBe('seed-skill');
          // Verify persisted to store
          const stored = await workflowStore.getSkillManifest('seed-skill');
          expect(stored?.manifest).toMatchObject({ id: 'seed-skill' });
        },
        { launchSkills: [seedManifest] },
      );
    });

    it('is idempotent across repeated GET calls', async () => {
      const seedManifest = makeManifest({ id: 'seed-skill' });
      await withSkillsServer(
        DEFAULT_ENV,
        async ({ port, workflowStore, recurringStoreFor }) => {
          await getJson(port, '/api/skills', DEV_WALLET);
          await getJson(port, '/api/skills', DEV_WALLET);
          const records = await workflowStore.listSkillManifests();
          expect(records).toHaveLength(1);
        },
        { launchSkills: [seedManifest] },
      );
    });

    it('filters catalog manifests by author when author query param is set', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedManifest(workflowStore, makeManifest({
          id: 'author-one',
          authorWallet: DEV_WALLET,
        }));
        await seedManifest(workflowStore, makeManifest({
          id: 'author-two',
          authorWallet: AUTHOR_WALLET,
        }));

        const all = await getJson(port, '/api/skills', DEV_WALLET);
        expect((all.body as { skills: SkillManifest[] }).skills.map((skill) => skill.id).sort())
          .toEqual(['author-one', 'author-two']);

        const filtered = await getJson(port, `/api/skills?author=${encodeURIComponent(DEV_WALLET)}`, DEV_WALLET);
        expect((filtered.body as { skills: SkillManifest[] }).skills.map((skill) => skill.id))
          .toEqual(['author-one']);
      });
    });
  });

  describe('GET /api/skills/:id', () => {
    it('returns 404 for unknown skill id', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await getJson(port, '/api/skills/unknown-skill', DEV_WALLET);
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ error: 'skill_not_found' });
      });
    });

    it('returns manifest and null stats when no snapshot is present', async () => {
      const manifest = makeManifest({ id: 'detail-skill' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await getJson(port, '/api/skills/detail-skill', DEV_WALLET);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          skill: { id: 'detail-skill' },
          stats: null,
        });
      });
    });

    it('returns manifest and stats when an aggregator snapshot exists', async () => {
      const manifest = makeManifest({ id: 'detail-skill' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        await workflowStore.saveAggregatorSnapshot({
          key: 'skill:detail-skill',
          kind: 'skill',
          computedAt: FIXED_NOW.toISOString(),
          snapshot: { skillId: 'detail-skill', installs: 3, successRate: 0.95 },
        });
        const res = await getJson(port, '/api/skills/detail-skill', DEV_WALLET);
        expect(res.status).toBe(200);
        const body = res.body as { skill: SkillManifest; stats: Record<string, unknown> };
        expect(body.stats).toMatchObject({ installs: 3, successRate: 0.95 });
      });
    });
  });

  describe('GET /api/skills/authors/:wallet/earnings', () => {
    it('returns 403 when the connected wallet does not match the author wallet', async () => {
      await withSkillsServer(AUTHOR_ENV, async ({ port }) => {
        const res = await getJson(
          port,
          `/api/skills/authors/${AUTHOR_WALLET}/earnings`,
          DEV_WALLET,
        );
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'author_mismatch' });
      });
    });

    it('groups active monthly USDC skill monetization schedules by skill', async () => {
      await withSkillsServer(AUTHOR_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        const recurring = recurringStoreFor(workflowStore);
        await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({
          id: 'recurring_a',
          walletAddress: DEV_WALLET,
          amount: '5',
          metadata: {
            source: 'skill_install_monetization',
            skillInstallId: 'install_a',
            skillId: 'friday-dca',
            monetizationKind: 'monthly',
          },
        }));
        await recurring.saveSchedule(OTHER_WALLET, makeRecurringSchedule({
          id: 'recurring_b',
          walletAddress: OTHER_WALLET,
          amount: '2.50',
          metadata: {
            source: 'skill_install_monetization',
            skillInstallId: 'install_b',
            skillId: 'friday-dca',
            monetizationKind: 'monthly',
          },
        }));
        await recurring.saveSchedule(OTHER_WALLET, makeRecurringSchedule({
          id: 'recurring_c',
          walletAddress: OTHER_WALLET,
          amount: '0.333',
          metadata: {
            source: 'skill_install_monetization',
            skillInstallId: 'install_c',
            skillId: 'yield-auto-rotate',
            monetizationKind: 'monthly',
          },
        }));

        const res = await getJson(
          port,
          `/api/skills/authors/${AUTHOR_WALLET}/earnings`,
          AUTHOR_WALLET,
        );
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          authorWallet: AUTHOR_WALLET,
          currency: 'USDC',
          totalMonthlyUsdc: '7.833',
          skills: [
            { skillId: 'friday-dca', monthlyUsdc: '7.5', activeSubscriptions: 2 },
            { skillId: 'yield-auto-rotate', monthlyUsdc: '0.333', activeSubscriptions: 1 },
          ],
        });
      });
    });

    it('excludes inactive, non-USDC, non-skill, and other-recipient schedules', async () => {
      await withSkillsServer(AUTHOR_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        const recurring = recurringStoreFor(workflowStore);
        await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({ id: 'included', amount: '1' }));
        await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({ id: 'paused', status: 'paused', amount: '5' }));
        await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({ id: 'sol', token: 'SOL', amount: '5' }));
        await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({ id: 'other-recipient', recipient: OTHER_WALLET, amount: '5' }));
        await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({
          id: 'not-skill',
          amount: '5',
          metadata: { source: 'manual_recurring' },
        }));

        const res = await getJson(
          port,
          `/api/skills/authors/${AUTHOR_WALLET}/earnings`,
          AUTHOR_WALLET,
        );
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          totalMonthlyUsdc: '1',
          skills: [{ skillId: 'friday-dca', monthlyUsdc: '1', activeSubscriptions: 1 }],
        });
      });
    });

    it('returns an empty run-rate when the author has no active subscriptions', async () => {
      await withSkillsServer(AUTHOR_ENV, async ({ port }) => {
        const res = await getJson(
          port,
          `/api/skills/authors/${AUTHOR_WALLET}/earnings`,
          AUTHOR_WALLET,
        );
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          authorWallet: AUTHOR_WALLET,
          currency: 'USDC',
          totalMonthlyUsdc: '0',
          skills: [],
        });
      });
    });
  });

  describe('GET /api/skills/platform-earnings', () => {
    it('returns 503 when TREASURY_WALLET is unconfigured', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await getJson(port, '/api/skills/platform-earnings', DEV_WALLET);
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ error: 'treasury_not_configured' });
      });
    });

    it('returns 403 treasury_mismatch when caller is not the treasury wallet', async () => {
      await withSkillsServer(
        { ...DEFAULT_ENV, TREASURY_WALLET: AUTHOR_WALLET, PLATFORM_FEE_BPS: '1500' },
        async ({ port }) => {
          const res = await getJson(port, '/api/skills/platform-earnings', DEV_WALLET);
          expect(res.status).toBe(403);
          expect(res.body).toMatchObject({ error: 'treasury_mismatch' });
        },
      );
    });

    it('aggregates platformAmount across schedules tagged for the configured treasury', async () => {
      await withSkillsServer(
        { ...DEFAULT_ENV, TREASURY_WALLET: DEV_WALLET, PLATFORM_FEE_BPS: '1500' },
        async ({ port, workflowStore, recurringStoreFor }) => {
          const recurring = recurringStoreFor(workflowStore);
          await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({
            id: 'rec_a',
            walletAddress: DEV_WALLET,
            amount: '8.5',
            metadata: {
              source: 'skill_install_monetization',
              skillInstallId: 'install_a',
              skillId: 'friday-dca',
              monetizationKind: 'monthly',
              platformWallet: DEV_WALLET,
              platformAmount: '1.5',
              totalAmount: '10',
              platformFeeBps: 1500,
            },
          }));
          await recurring.saveSchedule(OTHER_WALLET, makeRecurringSchedule({
            id: 'rec_b',
            walletAddress: OTHER_WALLET,
            amount: '4.25',
            metadata: {
              source: 'skill_install_monetization',
              skillInstallId: 'install_b',
              skillId: 'friday-dca',
              monetizationKind: 'monthly',
              platformWallet: DEV_WALLET,
              platformAmount: '0.75',
              totalAmount: '5',
              platformFeeBps: 1500,
            },
          }));
          await recurring.saveSchedule(OTHER_WALLET, makeRecurringSchedule({
            id: 'rec_c',
            walletAddress: OTHER_WALLET,
            amount: '8.5',
            metadata: {
              source: 'skill_install_monetization',
              skillInstallId: 'install_c',
              skillId: 'yield-auto-rotate',
              monetizationKind: 'monthly',
              platformWallet: DEV_WALLET,
              platformAmount: '1.5',
              totalAmount: '10',
              platformFeeBps: 1500,
            },
          }));

          const res = await getJson(port, '/api/skills/platform-earnings', DEV_WALLET);
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({
            treasuryWallet: DEV_WALLET,
            platformFeeBps: 1500,
            currency: 'USDC',
            totalMonthlyUsdc: '3.75',
            skills: [
              { skillId: 'friday-dca', monthlyUsdc: '2.25', activeSubscriptions: 2 },
              { skillId: 'yield-auto-rotate', monthlyUsdc: '1.5', activeSubscriptions: 1 },
            ],
          });
        },
      );
    });

    it('skips schedules without platformAmount or with a different treasury', async () => {
      await withSkillsServer(
        { ...DEFAULT_ENV, TREASURY_WALLET: DEV_WALLET, PLATFORM_FEE_BPS: '1500' },
        async ({ port, workflowStore, recurringStoreFor }) => {
          const recurring = recurringStoreFor(workflowStore);
          // No platformAmount → skip.
          await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({
            id: 'no_platform',
            amount: '10',
            metadata: {
              source: 'skill_install_monetization',
              skillInstallId: 'install_x',
              skillId: 'friday-dca',
              monetizationKind: 'monthly',
            },
          }));
          // Different treasury → skip.
          await recurring.saveSchedule(DEV_WALLET, makeRecurringSchedule({
            id: 'other_treasury',
            amount: '8.5',
            metadata: {
              source: 'skill_install_monetization',
              skillInstallId: 'install_y',
              skillId: 'friday-dca',
              monetizationKind: 'monthly',
              platformWallet: OTHER_WALLET,
              platformAmount: '1.5',
              totalAmount: '10',
              platformFeeBps: 1500,
            },
          }));

          const res = await getJson(port, '/api/skills/platform-earnings', DEV_WALLET);
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({ totalMonthlyUsdc: '0', skills: [] });
        },
      );
    });
  });

  describe('POST /api/skills/manifests', () => {
    it('returns 400 on invalid JSON body', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await rawRequest(port, 'POST', '/api/skills/manifests', {
          wallet: DEV_WALLET,
          rawBody: '{not json',
        });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'invalid_json' });
      });
    });

    it('returns 403 author_mismatch when authorWallet does not match connected wallet', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const manifest = makeManifest({ id: 'auth-mismatch' });
        const res = await postJson(port, '/api/skills/manifests', manifest, DEV_WALLET);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'author_mismatch' });
      });
    });

    it('returns 400 forbidden_authority on delegatedSigner in paramsTemplate', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const manifest = makeManifest({
          id: 'forbidden-delegated',
          authorWallet: DEV_WALLET,
          action: {
            connectorAction: 'prepare_swap',
            paramsTemplate: { delegatedSigner: 'someKey' },
          },
        });
        const res = await postJson(port, '/api/skills/manifests', manifest, DEV_WALLET);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'forbidden_authority' });
      });
    });

    it('returns 400 forbidden_authority on approvalAuthority: "unlimited"', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const manifest = makeManifest({
          id: 'forbidden-unlimited',
          authorWallet: DEV_WALLET,
        });
        // Inject the forbidden field at the top level of the payload
        const payload = { ...manifest, approvalAuthority: 'unlimited' };
        const res = await postJson(port, '/api/skills/manifests', payload, DEV_WALLET);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'forbidden_authority' });
      });
    });

    it('returns 400 forbidden_authority on nested privateKey in dependencies', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const manifest = makeManifest({
          id: 'forbidden-private',
          authorWallet: DEV_WALLET,
        });
        // privateKey nested inside dependencies entry should still trip the scan
        const payload = {
          ...manifest,
          dependencies: [{ skillId: 'foo', version: '1.0.0', privateKey: 'leak' }],
        };
        const res = await postJson(port, '/api/skills/manifests', payload, DEV_WALLET);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'forbidden_authority' });
      });
    });

    it('stores a valid manifest and returns 201', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        const manifest = makeManifest({
          id: 'valid-skill',
          authorWallet: DEV_WALLET,
        });
        const res = await postJson(port, '/api/skills/manifests', manifest, DEV_WALLET);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ skill: { id: 'valid-skill', authorWallet: DEV_WALLET } });
        const stored = await workflowStore.getSkillManifest('valid-skill');
        expect(stored?.manifest).toMatchObject({ id: 'valid-skill' });
      });
    });

    it('rejects re-publishing the same skill version with a different manifest body', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const manifest = makeManifest({
          id: 'version-conflict',
          authorWallet: DEV_WALLET,
        });
        const first = await postJson(port, '/api/skills/manifests', manifest, DEV_WALLET);
        expect(first.status).toBe(201);

        const second = await postJson(
          port,
          '/api/skills/manifests',
          {
            ...manifest,
            description: 'Changed body without a version bump',
          },
          DEV_WALLET,
        );

        expect(second.status).toBe(409);
        expect(second.body).toMatchObject({ error: 'manifest_version_conflict' });
      });
    });
  });

  describe('POST /api/skills/installs', () => {
    it('returns 404 for unknown skill id', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'unknown',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ error: 'skill_not_found' });
      });
    });

    it('returns 400 caps_too_loose when user perRunMaxAmount exceeds manifest', async () => {
      const manifest = makeManifest({ id: 'caps-too-loose' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'caps-too-loose',
            manifestVersion: '1.0.0',
            caps: defaultCaps({ perRunMaxAmount: '100' }),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'caps_too_loose', path: '$.caps.perRunMaxAmount' });
      });
    });

    it('returns 400 caps_token_not_allowed when user adds a token outside manifest allowlist', async () => {
      const manifest = makeManifest({ id: 'token-not-allowed' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'token-not-allowed',
            manifestVersion: '1.0.0',
            caps: defaultCaps({ allowlistedTokens: ['SOL', 'BONK'] }),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'caps_token_not_allowed' });
      });
    });

    it('returns 400 when install caps contain a non-integer maxExecutions', async () => {
      const manifest = makeManifest({ id: 'strict-max-executions' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'strict-max-executions',
            manifestVersion: '1.0.0',
            caps: {
              ...defaultCaps(),
              maxExecutions: 1.5,
            },
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'invalid_caps', path: '$.caps.maxExecutions' });
      });
    });

    it('returns 400 when install caps contain mixed-type token arrays', async () => {
      const manifest = makeManifest({ id: 'strict-token-array' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'strict-token-array',
            manifestVersion: '1.0.0',
            caps: {
              perRunMaxAmount: '25',
              lifetimeMaxAmount: '1300',
              allowlistedTokens: ['SOL', 123],
            },
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'invalid_caps', path: '$.caps.allowlistedTokens[1]' });
      });
    });

    it('returns 409 already_installed on duplicate active install', async () => {
      const manifest = makeManifest({ id: 'dup-skill' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const installBody = {
          skillId: 'dup-skill',
          manifestVersion: '1.0.0',
          caps: defaultCaps(),
          acceptMonetization: false,
        };
        const first = await postJson(port, '/api/skills/installs', installBody, DEV_WALLET);
        expect(first.status).toBe(201);
        const second = await postJson(port, '/api/skills/installs', installBody, DEV_WALLET);
        expect(second.status).toBe(409);
        expect(second.body).toMatchObject({ error: 'already_installed' });
      });
    });

    it('allows re-install after uninstall (status: revoked does not block)', async () => {
      const manifest = makeManifest({ id: 'reinstall-skill' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const installBody = {
          skillId: 'reinstall-skill',
          manifestVersion: '1.0.0',
          caps: defaultCaps(),
          acceptMonetization: false,
        };
        const first = await postJson(port, '/api/skills/installs', installBody, DEV_WALLET);
        expect(first.status).toBe(201);
        const installId = (first.body as { install: SkillInstallRecord }).install.id;
        const uninstall = await postJson(
          port,
          `/api/skills/installs/${installId}/uninstall`,
          {},
          DEV_WALLET,
        );
        expect(uninstall.status).toBe(200);
        const second = await postJson(port, '/api/skills/installs', installBody, DEV_WALLET);
        expect(second.status).toBe(201);
      });
    });

    it('creates an install without recurring schedule when no monetization', async () => {
      const manifest = makeManifest({ id: 'no-monetization' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'no-monetization',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(201);
        const install = (res.body as { install: SkillInstallRecord }).install;
        expect(install.monetizationScheduleId).toBeUndefined();
        expect(install.metadata).toMatchObject({
          manifestVersion: '1.0.0',
          manifestHash: expect.stringMatching(/^sha256:/),
          manifestSnapshot: { id: 'no-monetization', version: '1.0.0' },
          capsSnapshot: {
            perRunMaxAmount: '25',
            lifetimeMaxAmount: '1300',
            allowlistedTokens: ['SOL'],
          },
        });
        const recurring = recurringStoreFor(workflowStore);
        const schedules = await recurring.listSchedules(DEV_WALLET);
        expect(schedules).toHaveLength(0);
      });
    });

    it('persists required installParams and mirrors recipient params into caps', async () => {
      const manifest = makeManifest({
        id: 'dynamic-recipient',
        action: {
          connectorAction: 'prepare_transfer_spl',
          paramsTemplate: {
            token: 'USDC',
            recipient: '{{install.recipient}}',
            amount: '10',
          },
        },
        caps: {
          perRunMaxAmount: '10',
          lifetimeMaxAmount: '120',
          allowlistedTokens: ['USDC'],
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'dynamic-recipient',
            manifestVersion: '1.0.0',
            caps: {
              perRunMaxAmount: '10',
              lifetimeMaxAmount: '120',
              allowlistedTokens: ['USDC'],
            },
            installParams: {
              recipient: 'Recipient111111111111111111111111111111111',
            },
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(201);
        const install = (res.body as { install: SkillInstallRecord }).install;
        expect(install.metadata).toMatchObject({
          installParams: {
            recipient: 'Recipient111111111111111111111111111111111',
          },
        });
        expect(install.caps.allowlistedRecipients).toEqual([
          'Recipient111111111111111111111111111111111',
        ]);
        expect(await recurringStoreFor(workflowStore).listSchedules(DEV_WALLET)).toHaveLength(0);
      });
    });

    it('rejects missing required installParams', async () => {
      const manifest = makeManifest({
        id: 'missing-install-param',
        action: {
          connectorAction: 'prepare_transfer_spl',
          paramsTemplate: {
            token: 'USDC',
            recipient: '{{install.recipient}}',
            amount: '10',
          },
        },
        caps: {
          perRunMaxAmount: '10',
          lifetimeMaxAmount: '120',
          allowlistedTokens: ['USDC'],
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'missing-install-param',
            manifestVersion: '1.0.0',
            caps: {
              perRunMaxAmount: '10',
              lifetimeMaxAmount: '120',
              allowlistedTokens: ['USDC'],
            },
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          error: 'install_param_required',
          path: '$.installParams.recipient',
        });
        expect(await recurringStoreFor(workflowStore).listSchedules(DEV_WALLET)).toHaveLength(0);
      });
    });

    it('does not let installParams broaden a fixed manifest recipient allowlist', async () => {
      const manifest = makeManifest({
        id: 'fixed-recipient',
        action: {
          connectorAction: 'prepare_transfer_spl',
          paramsTemplate: {
            token: 'USDC',
            recipient: '{{install.recipient}}',
            amount: '10',
          },
        },
        caps: {
          perRunMaxAmount: '10',
          lifetimeMaxAmount: '120',
          allowlistedTokens: ['USDC'],
          allowlistedRecipients: ['AllowedRecipient111111111111111111111111111'],
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'fixed-recipient',
            manifestVersion: '1.0.0',
            caps: {
              perRunMaxAmount: '10',
              lifetimeMaxAmount: '120',
              allowlistedTokens: ['USDC'],
            },
            installParams: {
              recipient: 'OtherRecipient11111111111111111111111111111',
            },
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          error: 'install_param_recipient_not_allowed',
          path: '$.installParams.recipient',
        });
        expect(await recurringStoreFor(workflowStore).listSchedules(DEV_WALLET)).toHaveLength(0);
      });
    });

    it('creates a USDC recurring schedule when monthly monetization is accepted', async () => {
      const manifest = makeManifest({
        id: 'monthly-usdc',
        monetization: {
          kind: 'monthly',
          amount: '5',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'monthly-usdc',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(201);
        const install = (res.body as { install: SkillInstallRecord }).install;
        expect(install.monetizationScheduleId).toMatch(/^recurring_/);
        const recurring = recurringStoreFor(workflowStore);
        const schedules = await recurring.listSchedules(DEV_WALLET);
        expect(schedules).toHaveLength(1);
        const schedule = schedules[0];
        expect(schedule).toMatchObject({
          token: 'USDC',
          amount: '5',
          cadence: 'monthly',
          dayOfMonth: 14,
          localTime: '12:00',
          recipient: AUTHOR_WALLET,
          status: 'active',
        });
        expect(schedule?.memo).toBe(`Author fee: ${manifest.name} v${manifest.version}`);
        expect(schedule?.metadata).toMatchObject({
          source: 'skill_install_monetization',
          skillId: 'monthly-usdc',
        });
      });
    });

    it('rejects a monetized install when acceptMonetization is false', async () => {
      const manifest = makeManifest({
        id: 'monthly-declined',
        monetization: {
          kind: 'monthly',
          amount: '5',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'monthly-declined',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'monetization_required' });
        const recurring = recurringStoreFor(workflowStore);
        expect(await recurring.listSchedules(DEV_WALLET)).toHaveLength(0);
        expect(await workflowStore.listSkillInstallsForWallet(DEV_WALLET)).toHaveLength(0);
      });
    });

    it('creates a one-time transfer_spl approval when treasury is unconfigured', async () => {
      const manifest = makeManifest({
        id: 'one-time-skill',
        monetization: {
          kind: 'one-time',
          amount: '10',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'one-time-skill',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(201);
        const install = (res.body as { install: SkillInstallRecord }).install;
        expect(install.monetizationScheduleId).toBeUndefined();
        const oneTimeApprovalId = (install.metadata as { oneTimeApprovalId?: string }).oneTimeApprovalId;
        expect(typeof oneTimeApprovalId).toBe('string');
        const recurring = recurringStoreFor(workflowStore);
        expect(await recurring.listSchedules(DEV_WALLET)).toHaveLength(0);
        const approvals = await workflowStore.listApprovals(DEV_WALLET);
        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.kind).toBe('transfer_spl');
        expect(approvals[0]?.recipient).toBe(AUTHOR_WALLET);
        expect(approvals[0]?.amount).toBe('10');
      });
    });

    it('creates a one-time skill_fee_split approval when TREASURY_WALLET is set', async () => {
      const manifest = makeManifest({
        id: 'one-time-split',
        monetization: {
          kind: 'one-time',
          amount: '10',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(
        { ...DEFAULT_ENV, TREASURY_WALLET: DEV_WALLET, PLATFORM_FEE_BPS: '1500' },
        async ({ port, workflowStore, recurringStoreFor }) => {
          await seedManifest(workflowStore, manifest);
          const res = await postJson(
            port,
            '/api/skills/installs',
            {
              skillId: 'one-time-split',
              manifestVersion: '1.0.0',
              caps: defaultCaps(),
              acceptMonetization: true,
            },
            DEV_WALLET,
          );
          expect(res.status).toBe(201);
          const install = (res.body as { install: SkillInstallRecord }).install;
          expect(install.metadata).toMatchObject({
            monetizationSplit: {
              platformWallet: DEV_WALLET,
              platformAmount: '1.5',
              totalAmount: '10',
              platformFeeBps: 1500,
            },
          });
          const recurring = recurringStoreFor(workflowStore);
          expect(await recurring.listSchedules(DEV_WALLET)).toHaveLength(0);
          const approvals = await workflowStore.listApprovals(DEV_WALLET);
          expect(approvals).toHaveLength(1);
          const approval = approvals[0]!;
          expect(approval.kind).toBe('skill_fee_split');
          expect(approval.params).toMatchObject({
            token: 'USDC',
            authorRecipient: AUTHOR_WALLET,
            authorAmount: '8.5',
            treasuryRecipient: DEV_WALLET,
            treasuryAmount: '1.5',
          });
        },
      );
    });

    it('creates a monthly schedule with skill_fee_split metadata when TREASURY_WALLET is set', async () => {
      const manifest = makeManifest({
        id: 'monthly-split',
        monetization: {
          kind: 'monthly',
          amount: '10',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(
        { ...DEFAULT_ENV, TREASURY_WALLET: DEV_WALLET, PLATFORM_FEE_BPS: '1500' },
        async ({ port, workflowStore, recurringStoreFor }) => {
          await seedManifest(workflowStore, manifest);
          const res = await postJson(
            port,
            '/api/skills/installs',
            {
              skillId: 'monthly-split',
              manifestVersion: '1.0.0',
              caps: defaultCaps(),
              acceptMonetization: true,
            },
            DEV_WALLET,
          );
          expect(res.status).toBe(201);
          const recurring = recurringStoreFor(workflowStore);
          const schedules = await recurring.listSchedules(DEV_WALLET);
          expect(schedules).toHaveLength(1);
          const schedule = schedules[0]!;
          expect(schedule.recipient).toBe(AUTHOR_WALLET);
          expect(schedule.amount).toBe('8.5');
          expect(schedule.metadata).toMatchObject({
            source: 'skill_install_monetization',
            platformWallet: DEV_WALLET,
            platformAmount: '1.5',
            totalAmount: '10',
            platformFeeBps: 1500,
          });
        },
      );
    });

    it('falls back to a single-recipient monthly schedule when TREASURY_WALLET is unset', async () => {
      const manifest = makeManifest({
        id: 'monthly-no-split',
        monetization: {
          kind: 'monthly',
          amount: '10',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'monthly-no-split',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(201);
        const recurring = recurringStoreFor(workflowStore);
        const schedules = await recurring.listSchedules(DEV_WALLET);
        expect(schedules).toHaveLength(1);
        const schedule = schedules[0]!;
        expect(schedule.recipient).toBe(AUTHOR_WALLET);
        expect(schedule.amount).toBe('10');
        expect(schedule.metadata).toMatchObject({ source: 'skill_install_monetization' });
        expect((schedule.metadata as { platformWallet?: unknown }).platformWallet).toBeUndefined();
      });
    });

    it('accepts performance-fee installs with deferred-settlement metadata', async () => {
      const manifest = makeManifest({
        id: 'perf-fee-skill',
        monetization: {
          kind: 'performance-fee',
          feePercent: 10,
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'perf-fee-skill',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(201);
        const install = (res.body as { install: SkillInstallRecord }).install;
        expect(install.metadata).toMatchObject({ performanceFeeDeferred: true });
        expect(install.monetizationScheduleId).toBeUndefined();
        const recurring = recurringStoreFor(workflowStore);
        expect(await recurring.listSchedules(DEV_WALLET)).toHaveLength(0);
        expect(await workflowStore.listApprovals(DEV_WALLET)).toHaveLength(0);
      });
    });

    it('rejects installs when the requested manifest version is stale', async () => {
      const manifest = makeManifest({
        id: 'stale-version',
        version: '2.0.0',
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const res = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'stale-version',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'manifest_version_mismatch' });
        const recurring = recurringStoreFor(workflowStore);
        expect(await recurring.listSchedules(DEV_WALLET)).toHaveLength(0);
        expect(await workflowStore.listSkillInstallsForWallet(DEV_WALLET)).toHaveLength(0);
      });
    });

    // ─── $SKR monetization (Android-only bounty + fail-closed guard) ──────
    //
    // Coverage for the install-time SKR gating added in the Solana Mobile
    // Seeker rollout. The guard at skillsRoutes.handleInstall is fail-closed:
    // a $SKR-priced manifest must be rejected up-front on deployments that
    // didn't set `SKR_TOKEN_MINT`, otherwise the install would succeed and
    // the resulting recurring schedule would later be rejected by
    // `isSupportedCloudTransferToken` at execution time — a silent failure
    // for the installer.
    describe('$SKR monetization', () => {
      // Real Solana base58 pubkey (USDC mint) — passes the cloud's base58
      // validators without smuggling a real $SKR mint dependency. The mint
      // identity doesn't matter for these unit tests; we just need a value
      // that survives `readSkrMint`.
      const VALID_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

      it('rejects $SKR-priced install with skr_not_configured when SKR_TOKEN_MINT is unset', async () => {
        const manifest = makeManifest({
          id: 'skr-priced-uncfg',
          monetization: {
            kind: 'monthly',
            payoutWallet: AUTHOR_WALLET,
            amount: '5',
            token: 'SKR',
          },
        });
        await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
          await seedManifest(workflowStore, manifest);
          const res = await postJson(
            port,
            '/api/skills/installs',
            {
              skillId: 'skr-priced-uncfg',
              manifestVersion: '1.0.0',
              caps: defaultCaps(),
              acceptMonetization: true,
            },
            DEV_WALLET,
          );
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({
            error: 'skr_not_configured',
            path: '$.monetization.token',
          });
          // Critical assertion: no install/schedule was persisted. The whole
          // install transaction unwinds so the user isn't charged for a
          // schedule that can't execute.
          const recurring = recurringStoreFor(workflowStore);
          expect(await recurring.listSchedules(DEV_WALLET)).toHaveLength(0);
          expect(await workflowStore.listSkillInstallsForWallet(DEV_WALLET)).toHaveLength(0);
        });
      });

      it('accepts $SKR-priced install when SKR_TOKEN_MINT is configured and records monetizationToken=SKR', async () => {
        const manifest = makeManifest({
          id: 'skr-priced-cfg',
          monetization: {
            kind: 'monthly',
            payoutWallet: AUTHOR_WALLET,
            amount: '5',
            token: 'SKR',
          },
        });
        const env: EnvSnapshot = { ...DEFAULT_ENV, SKR_TOKEN_MINT: VALID_MINT };
        await withSkillsServer(env, async ({ port, workflowStore, recurringStoreFor }) => {
          await seedManifest(workflowStore, manifest);
          const res = await postJson(
            port,
            '/api/skills/installs',
            {
              skillId: 'skr-priced-cfg',
              manifestVersion: '1.0.0',
              caps: defaultCaps(),
              acceptMonetization: true,
            },
            DEV_WALLET,
          );
          expect(res.status).toBe(201);
          const recurring = recurringStoreFor(workflowStore);
          const schedules = await recurring.listSchedules(DEV_WALLET);
          expect(schedules).toHaveLength(1);
          expect(schedules[0]).toMatchObject({ token: 'SKR' });
          expect(schedules[0]?.metadata).toMatchObject({ monetizationToken: 'SKR' });
        });
      });

      it('records bountyApplied + waives platform fee when Android client installs $SKR-priced skill with bounty active', async () => {
        // Treasury must be configured for the bounty waiver to be observable;
        // otherwise there's no platform fee to waive in the first place.
        const env: EnvSnapshot = {
          ...DEFAULT_ENV,
          SKR_TOKEN_MINT: VALID_MINT,
          SKR_SKILL_BOUNTY_ACTIVE: 'true',
          TREASURY_WALLET: '11111111111111111111111111111111',
          PLATFORM_FEE_BPS: '1500',
        };
        const manifest = makeManifest({
          id: 'skr-bounty',
          monetization: {
            kind: 'monthly',
            payoutWallet: AUTHOR_WALLET,
            amount: '5',
            token: 'SKR',
          },
        });
        await withSkillsServer(env, async ({ port, workflowStore, recurringStoreFor }) => {
          await seedManifest(workflowStore, manifest);
          const res = await postJson(
            port,
            '/api/skills/installs',
            {
              skillId: 'skr-bounty',
              manifestVersion: '1.0.0',
              caps: defaultCaps(),
              acceptMonetization: true,
            },
            DEV_WALLET,
            { 'x-agentic-client': 'android-bundled' },
          );
          expect(res.status).toBe(201);
          const install = (res.body as { install: SkillInstallRecord }).install;
          expect(install.metadata).toMatchObject({
            monetizationBounty: { program: 'android_skr_v1', token: 'SKR' },
          });
          // The bounty waives the platform fee — the recurring schedule
          // should carry the full author amount, with no platformAmount
          // metadata recorded.
          const recurring = recurringStoreFor(workflowStore);
          const schedules = await recurring.listSchedules(DEV_WALLET);
          expect(schedules).toHaveLength(1);
          expect(schedules[0]?.amount).toBe('5');
          expect(schedules[0]?.metadata).toMatchObject({
            bountyApplied: true,
            bountyProgram: 'android_skr_v1',
          });
          expect(schedules[0]?.metadata).not.toHaveProperty('platformAmount');
        });
      });

      it('does NOT apply the bounty when the same install comes from a web client', async () => {
        const env: EnvSnapshot = {
          ...DEFAULT_ENV,
          SKR_TOKEN_MINT: VALID_MINT,
          SKR_SKILL_BOUNTY_ACTIVE: 'true',
          TREASURY_WALLET: '11111111111111111111111111111111',
          PLATFORM_FEE_BPS: '1500',
        };
        const manifest = makeManifest({
          id: 'skr-web-no-bounty',
          monetization: {
            kind: 'monthly',
            payoutWallet: AUTHOR_WALLET,
            amount: '5',
            token: 'SKR',
          },
        });
        await withSkillsServer(env, async ({ port, workflowStore, recurringStoreFor }) => {
          await seedManifest(workflowStore, manifest);
          const res = await postJson(
            port,
            '/api/skills/installs',
            {
              skillId: 'skr-web-no-bounty',
              manifestVersion: '1.0.0',
              caps: defaultCaps(),
              acceptMonetization: true,
            },
            DEV_WALLET,
            // No `x-agentic-client` header — this is the web path.
          );
          expect(res.status).toBe(201);
          const install = (res.body as { install: SkillInstallRecord }).install;
          expect(install.metadata).not.toHaveProperty('monetizationBounty');
          const recurring = recurringStoreFor(workflowStore);
          const schedules = await recurring.listSchedules(DEV_WALLET);
          expect(schedules[0]?.metadata).toMatchObject({ platformAmount: expect.any(String) });
        });
      });
    });
  });

  describe('GET /api/skills/installs', () => {
    it('returns empty list when no installs', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await getJson(port, '/api/skills/installs', DEV_WALLET);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ installs: [], installRows: [] });
      });
    });

    it('returns only the connected wallet installs (no cross-wallet leak)', async () => {
      const manifest = makeManifest({ id: 'iso-skill' });
      const extraAllowlist = `${DEV_WALLET},${OTHER_WALLET}`;
      await withSkillsServer(
        { ...DEFAULT_ENV, AGENTIC_DEV_WALLET_ALLOWLIST: extraAllowlist },
        async ({ port, workflowStore, recurringStoreFor }) => {
          await seedManifest(workflowStore, manifest);
          const installBody = {
            skillId: 'iso-skill',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: false,
          };
          await postJson(port, '/api/skills/installs', installBody, DEV_WALLET);
          await postJson(port, '/api/skills/installs', installBody, OTHER_WALLET);
          const devList = (await getJson(port, '/api/skills/installs', DEV_WALLET)).body as {
            installs: SkillInstallRecord[];
          };
          const otherList = (await getJson(port, '/api/skills/installs', OTHER_WALLET)).body as {
            installs: SkillInstallRecord[];
          };
          expect(devList.installs).toHaveLength(1);
          expect(devList.installs[0]?.walletAddress).toBe(DEV_WALLET);
          expect(otherList.installs).toHaveLength(1);
          expect(otherList.installs[0]?.walletAddress).toBe(OTHER_WALLET);
        },
      );
    });

    it('includes monetizationScheduleId in install records when present', async () => {
      const manifest = makeManifest({
        id: 'with-schedule',
        monetization: {
          kind: 'monthly',
          amount: '5',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'with-schedule',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        const res = await getJson(port, '/api/skills/installs', DEV_WALLET);
        const body = res.body as {
          installs: SkillInstallRecord[];
          installRows: SkillInstallListRow[];
        };
        const installs = body.installs;
        expect(installs).toHaveLength(1);
        expect(installs[0]?.monetizationScheduleId).toMatch(/^recurring_/);
        expect(body.installRows[0]?.recurringScheduleStatus).toBe('active');
      });
    });

    it('includes UI installRows with manifest, recent run count, last run, and next run', async () => {
      const manifest = makeManifest({ id: 'ui-row-skill' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore }) => {
        await seedManifest(workflowStore, manifest);
        const installRes = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'ui-row-skill',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        const install = (installRes.body as { install: SkillInstallRecord }).install;
        const recentExecution: SkillExecutionRecord = {
          id: 'skill_exec_recent',
          installId: install.id,
          walletAddress: DEV_WALLET,
          skillId: install.skillId,
          proposedAt: '2026-05-13T12:00:00.000Z',
          approvalRequestId: 'approval_recent',
          result: 'success',
        };
        await workflowStore.saveSkillExecution({
          id: recentExecution.id,
          installId: install.id,
          walletAddress: DEV_WALLET,
          skillId: install.skillId,
          proposedAt: recentExecution.proposedAt,
          result: recentExecution.result,
          approvalRequestId: recentExecution.approvalRequestId,
          execution: recentExecution,
        });
        const oldExecution: SkillExecutionRecord = {
          id: 'skill_exec_old',
          installId: install.id,
          walletAddress: DEV_WALLET,
          skillId: install.skillId,
          proposedAt: '2026-05-01T12:00:00.000Z',
          approvalRequestId: 'approval_old',
          result: 'success',
        };
        await workflowStore.saveSkillExecution({
          id: oldExecution.id,
          installId: install.id,
          walletAddress: DEV_WALLET,
          skillId: install.skillId,
          proposedAt: oldExecution.proposedAt,
          result: oldExecution.result,
          approvalRequestId: oldExecution.approvalRequestId,
          execution: oldExecution,
        });

        const res = await getJson(port, '/api/skills/installs', DEV_WALLET);
        const rows = (res.body as { installRows: SkillInstallListRow[] }).installRows;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.install.id).toBe(install.id);
        expect(rows[0]?.manifest?.name).toBe('Test Skill');
        expect(rows[0]?.recentExecutionCount).toBe(1);
        expect(rows[0]?.lastExecutionAt).toBe('2026-05-13T12:00:00.000Z');
        expect(rows[0]?.nextRunAt).toBe('2026-05-15T14:00:00.000Z');
      });
    });
  });

  describe('POST /api/skills/installs/:id/pause', () => {
    it('returns 404 for unknown install id', async () => {
      await withSkillsServer(DEFAULT_ENV, async ({ port }) => {
        const res = await postJson(
          port,
          '/api/skills/installs/nonexistent_id/pause',
          {},
          DEV_WALLET,
        );
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ error: 'install_not_found' });
      });
    });

    it('returns 404 for another wallet’s install (no info leak)', async () => {
      const manifest = makeManifest({ id: 'iso-skill' });
      const extraAllowlist = `${DEV_WALLET},${OTHER_WALLET}`;
      await withSkillsServer(
        { ...DEFAULT_ENV, AGENTIC_DEV_WALLET_ALLOWLIST: extraAllowlist },
        async ({ port, workflowStore, recurringStoreFor }) => {
          await seedManifest(workflowStore, manifest);
          const installRes = await postJson(
            port,
            '/api/skills/installs',
            {
              skillId: 'iso-skill',
              manifestVersion: '1.0.0',
              caps: defaultCaps(),
              acceptMonetization: false,
            },
            DEV_WALLET,
          );
          const installId = (installRes.body as { install: SkillInstallRecord }).install.id;
          const res = await postJson(
            port,
            `/api/skills/installs/${installId}/pause`,
            {},
            OTHER_WALLET,
          );
          expect(res.status).toBe(404);
          expect(res.body).toMatchObject({ error: 'install_not_found' });
        },
      );
    });

    it('returns 409 invalid_state when install is already paused', async () => {
      const manifest = makeManifest({ id: 'pause-twice' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const installRes = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'pause-twice',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        const installId = (installRes.body as { install: SkillInstallRecord }).install.id;
        const first = await postJson(port, `/api/skills/installs/${installId}/pause`, {}, DEV_WALLET);
        expect(first.status).toBe(200);
        const second = await postJson(port, `/api/skills/installs/${installId}/pause`, {}, DEV_WALLET);
        expect(second.status).toBe(409);
        expect(second.body).toMatchObject({ error: 'invalid_state' });
      });
    });

    it('pauses the install and the linked recurring schedule', async () => {
      const manifest = makeManifest({
        id: 'pause-schedule',
        monetization: {
          kind: 'monthly',
          amount: '5',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const installRes = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'pause-schedule',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        const install = (installRes.body as { install: SkillInstallRecord }).install;
        const pauseRes = await postJson(
          port,
          `/api/skills/installs/${install.id}/pause`,
          {},
          DEV_WALLET,
        );
        expect(pauseRes.status).toBe(200);
        expect((pauseRes.body as { install: SkillInstallRecord }).install.status).toBe('paused');
        const recurring = recurringStoreFor(workflowStore);
        const schedules = await recurring.listSchedules(DEV_WALLET);
        expect(schedules[0]?.status).toBe('paused');
      });
    });
  });

  describe('POST /api/skills/installs/:id/resume', () => {
    it('returns 409 when install is not paused', async () => {
      const manifest = makeManifest({ id: 'resume-active' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const installRes = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'resume-active',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        const installId = (installRes.body as { install: SkillInstallRecord }).install.id;
        const res = await postJson(
          port,
          `/api/skills/installs/${installId}/resume`,
          {},
          DEV_WALLET,
        );
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: 'invalid_state' });
      });
    });

    it('resumes a paused install and its linked schedule', async () => {
      const manifest = makeManifest({
        id: 'resume-with-schedule',
        monetization: {
          kind: 'monthly',
          amount: '5',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const installRes = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'resume-with-schedule',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        const install = (installRes.body as { install: SkillInstallRecord }).install;
        await postJson(port, `/api/skills/installs/${install.id}/pause`, {}, DEV_WALLET);
        const resumeRes = await postJson(
          port,
          `/api/skills/installs/${install.id}/resume`,
          {},
          DEV_WALLET,
        );
        expect(resumeRes.status).toBe(200);
        expect((resumeRes.body as { install: SkillInstallRecord }).install.status).toBe('active');
        const recurring = recurringStoreFor(workflowStore);
        const schedules = await recurring.listSchedules(DEV_WALLET);
        expect(schedules[0]?.status).toBe('active');
      });
    });
  });

  describe('POST /api/skills/installs/:id/uninstall', () => {
    it('marks install as revoked and pauses the linked schedule (does not delete it)', async () => {
      const manifest = makeManifest({
        id: 'uninstall-with-schedule',
        monetization: {
          kind: 'monthly',
          amount: '5',
          payoutWallet: AUTHOR_WALLET,
        },
      });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const installRes = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'uninstall-with-schedule',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: true,
          },
          DEV_WALLET,
        );
        const install = (installRes.body as { install: SkillInstallRecord }).install;
        const uninstallRes = await postJson(
          port,
          `/api/skills/installs/${install.id}/uninstall`,
          {},
          DEV_WALLET,
        );
        expect(uninstallRes.status).toBe(200);
        expect((uninstallRes.body as { install: SkillInstallRecord }).install.status).toBe('revoked');
        const recurring = recurringStoreFor(workflowStore);
        const schedules = await recurring.listSchedules(DEV_WALLET);
        expect(schedules).toHaveLength(1);
        expect(schedules[0]?.status).toBe('paused');
        const listed = await getJson(port, '/api/skills/installs', DEV_WALLET);
        const body = listed.body as {
          installs: SkillInstallRecord[];
          installRows: SkillInstallListRow[];
        };
        expect(body.installs).toHaveLength(1);
        expect(body.installs[0]?.status).toBe('revoked');
        expect(body.installRows).toEqual([]);
      });
    });

    it('returns 409 when install is already revoked', async () => {
      const manifest = makeManifest({ id: 'uninstall-twice' });
      await withSkillsServer(DEFAULT_ENV, async ({ port, workflowStore, recurringStoreFor }) => {
        await seedManifest(workflowStore, manifest);
        const installRes = await postJson(
          port,
          '/api/skills/installs',
          {
            skillId: 'uninstall-twice',
            manifestVersion: '1.0.0',
            caps: defaultCaps(),
            acceptMonetization: false,
          },
          DEV_WALLET,
        );
        const installId = (installRes.body as { install: SkillInstallRecord }).install.id;
        await postJson(port, `/api/skills/installs/${installId}/uninstall`, {}, DEV_WALLET);
        const second = await postJson(
          port,
          `/api/skills/installs/${installId}/uninstall`,
          {},
          DEV_WALLET,
        );
        expect(second.status).toBe(409);
        expect(second.body).toMatchObject({ error: 'invalid_state' });
      });
    });
  });
});
