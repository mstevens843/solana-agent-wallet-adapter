import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLI_INSTALL_SNIPPET,
  __fetchAuthoredSkillsForTests,
  __getKickoffScheduledForTests,
  __getPanelStateForTests,
  __resetPanelStateForTests,
  buildSkillPageUrl,
  escapeHtml,
  filterRecordsForAuthor,
  formatInstalls,
  formatMonthlyUsdc,
  normalizeAuthorEarningsResponse,
  normalizeCatalogResponse,
  normalizeStatsResponse,
  renderPublishPanel,
  type SkillManifestRecord,
  type SkillStatsSnapshot,
} from '../skills/publish.js';
import {
  findSkillsSubTab,
  listSkillsSubTabs,
} from '../skills/subTabRegistry.js';
import { setConnectedAddress } from '../../walletState.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_WALLET = '9zZZyyXX0000000000000000000000000000000000';
const SECOND_WALLET = '11111111111111111111111111111111';

function makeRecord(overrides: Partial<SkillManifestRecord> & { id: string }): SkillManifestRecord {
  return {
    id: overrides.id,
    version: overrides.version ?? '1.0.0',
    authorWallet: overrides.authorWallet ?? DEV_WALLET,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    manifest: overrides.manifest ?? {
      id: overrides.id,
      name: overrides.id.replace(/-/g, ' '),
      version: overrides.version ?? '1.0.0',
      authorWallet: overrides.authorWallet ?? DEV_WALLET,
      description: `Demo skill ${overrides.id}`,
      category: 'dca',
      schedule: { kind: 'cron', spec: '0 12 * * 5' },
      action: { connectorAction: 'swap', paramsTemplate: {} },
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC', 'SOL'],
      },
    },
  };
}

function makeStats(overrides: Partial<SkillStatsSnapshot> & { skillId: string }): SkillStatsSnapshot {
  return {
    skillId: overrides.skillId,
    installs: overrides.installs ?? 7,
    totalExecutions: overrides.totalExecutions ?? 20,
    successRate: overrides.successRate ?? 0.95,
    computedAt: overrides.computedAt ?? new Date().toISOString(),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  __resetPanelStateForTests();
  setConnectedAddress(undefined);
});

afterEach(() => {
  __resetPanelStateForTests();
  setConnectedAddress(undefined);
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});

describe('pure helpers', () => {
  it('escapes HTML characters', () => {
    expect(escapeHtml('<b>"x"</b>')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });

  it('buildSkillPageUrl uses the fallback production origin outside the browser', () => {
    expect(buildSkillPageUrl('friday-dca')).toBe('https://agentic-signer.com/skills/friday-dca');
  });

  it('buildSkillPageUrl accepts the current app origin for local and staging builds', () => {
    expect(buildSkillPageUrl('friday-dca', 'http://localhost:3000/')).toBe('http://localhost:3000/skills/friday-dca');
    expect(buildSkillPageUrl('yield-auto-rotate', 'https://preview.example')).toBe('https://preview.example/skills/yield-auto-rotate');
  });

  it('CLI_INSTALL_SNIPPET contains the three documented commands', () => {
    expect(CLI_INSTALL_SNIPPET).toContain('npm install -g @solana-agent-wallet-adapter/skills-cli');
    expect(CLI_INSTALL_SNIPPET).toContain('agentic-skill init my-skill');
    expect(CLI_INSTALL_SNIPPET).toContain('agentic-skill publish ./my-skill/manifest.json');
  });

  it('filterRecordsForAuthor keeps matching wallets only', () => {
    const records = [
      makeRecord({ id: 'a', authorWallet: DEV_WALLET }),
      makeRecord({ id: 'b', authorWallet: OTHER_WALLET }),
      makeRecord({ id: 'c', authorWallet: DEV_WALLET }),
    ];
    const filtered = filterRecordsForAuthor(records, DEV_WALLET);
    expect(filtered.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('normalizeCatalogResponse accepts real catalog envelopes and legacy records', () => {
    const manifest = makeRecord({ id: 'friday-dca' }).manifest;
    expect(normalizeCatalogResponse({ skills: [manifest] }).map((r) => r.id)).toEqual(['friday-dca']);
    expect(normalizeCatalogResponse([makeRecord({ id: 'legacy-record' })]).map((r) => r.id)).toEqual(['legacy-record']);
    expect(normalizeCatalogResponse({ items: [manifest, { id: 1 }] })).toHaveLength(1);
    expect(normalizeCatalogResponse({ nope: [] })).toEqual([]);
  });

  it('normalizeStatsResponse unwraps aggregator envelopes', () => {
    const stats = makeStats({ skillId: 'friday-dca' });
    expect(normalizeStatsResponse(stats)).toEqual(stats);
    expect(normalizeStatsResponse({ snapshot: stats, kind: 'skill' })).toEqual(stats);
    expect(normalizeStatsResponse({ snapshot: { skillId: 'friday-dca' } })).toBeNull();
  });

  it('normalizeAuthorEarningsResponse validates the earnings shape', () => {
    const body = {
      authorWallet: DEV_WALLET,
      currency: 'USDC',
      totalMonthlyUsdc: '7.5',
      skills: [{ skillId: 'friday-dca', monthlyUsdc: '5', activeSubscriptions: 1 }],
    };
    expect(normalizeAuthorEarningsResponse(body)?.skills[0]?.monthlyUsdc).toBe('5');
    expect(normalizeAuthorEarningsResponse({ ...body, skills: [{ skillId: 'friday-dca' }] })).toBeNull();
  });

  it('formats install counts and monthly USDC values', () => {
    expect(formatInstalls(undefined)).toBe('-');
    expect(formatInstalls(1)).toBe('1 install');
    expect(formatInstalls(3)).toBe('3 installs');
    expect(formatMonthlyUsdc(undefined)).toBe('-');
    expect(formatMonthlyUsdc('0.00')).toBe('-');
    expect(formatMonthlyUsdc('5.25')).toBe('5.25 USDC/mo');
  });
});

describe('renderPublishPanel — CLI card', () => {
  it('renders the CLI card in every phase', () => {
    const phases = [
      'idle',
      'loading',
      'loaded',
      'empty',
      'error',
      'forbidden',
      'notDeployed',
      'noWallet',
    ] as const;
    for (const phase of phases) {
      __resetPanelStateForTests({ phase, wallet: DEV_WALLET });
      const html = renderPublishPanel();
      expect(html).toContain('Publish a skill');
      expect(html).toContain('data-skills-publish-action="copy-cli-snippet"');
      expect(html).toContain('npm install -g @solana-agent-wallet-adapter/skills-cli');
    }
  });
});

describe('renderPublishPanel — phase bodies', () => {
  it('noWallet prompts for wallet connection', () => {
    __resetPanelStateForTests({ phase: 'noWallet' });
    const html = renderPublishPanel();
    expect(html).toContain('Connect a wallet');
  });

  it('loading shows a skeleton', () => {
    __resetPanelStateForTests({ phase: 'loading' });
    const html = renderPublishPanel();
    expect(html).toContain('skills-publish-skeleton');
    expect(html).toContain('aria-busy="true"');
  });

  it('forbidden explains the missing permission', () => {
    __resetPanelStateForTests({ phase: 'forbidden' });
    const html = renderPublishPanel();
    expect(html).toContain('Permission required');
  });

  it('notDeployed explains the registry status', () => {
    __resetPanelStateForTests({ phase: 'notDeployed' });
    const html = renderPublishPanel();
    expect(html).toContain('Skill registry API unavailable');
    expect(html).toContain('/api/skills');
  });

  it('error surfaces the message + retry trigger', () => {
    __resetPanelStateForTests({ phase: 'error', errorMessage: 'kaboom!' });
    const html = renderPublishPanel();
    expect(html).toContain('kaboom!');
    expect(html).toContain('data-skills-publish-action="retry"');
  });

  it('empty shows the zero state', () => {
    __resetPanelStateForTests({ phase: 'empty', wallet: DEV_WALLET });
    const html = renderPublishPanel();
    expect(html).toContain("haven't published any skills");
  });

  it('loaded renders one row per record with install counts and monthly USDC', () => {
    const records = [
      { ...makeRecord({ id: 'friday-dca' }), stats: makeStats({ skillId: 'friday-dca', installs: 12 }), monthlyUsdc: '5' },
      { ...makeRecord({ id: 'yield-auto-rotate' }), stats: makeStats({ skillId: 'yield-auto-rotate', installs: 1 }), monthlyUsdc: '0' },
    ];
    __resetPanelStateForTests({ phase: 'loaded', wallet: DEV_WALLET, records });
    const html = renderPublishPanel();
    expect(html).toContain('friday-dca');
    expect(html).toContain('yield-auto-rotate');
    expect(html).toContain(buildSkillPageUrl('friday-dca'));
    expect(html).toContain(buildSkillPageUrl('yield-auto-rotate'));
    expect(html).toContain('Monthly earnings');
    expect(html).toContain('12 installs');
    expect(html).toContain('1 install');
    expect(html).toContain('5 USDC/mo');
    expect(html).toContain('2 live');
    // The second row has zero earnings, so only the earnings cell renders a placeholder.
    const dashCount = (html.match(/skills-publish-cell-value">-/g) ?? []).length;
    expect(dashCount).toBe(1);
  });
});

describe('fetchAuthoredSkills', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  it('200 with matching records → phase=loaded', async () => {
    const records = [makeRecord({ id: 'friday-dca' }), makeRecord({ id: 'bridge-idle-usdc' })];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { skills: records.map((record) => record.manifest) }))
      .mockResolvedValueOnce(jsonResponse(200, { snapshot: makeStats({ skillId: 'friday-dca', installs: 11 }) }))
      .mockResolvedValueOnce(jsonResponse(200, { snapshot: makeStats({ skillId: 'bridge-idle-usdc', installs: 4 }) }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authorWallet: DEV_WALLET,
        currency: 'USDC',
        totalMonthlyUsdc: '7.5',
        skills: [
          { skillId: 'friday-dca', monthlyUsdc: '5', activeSubscriptions: 1 },
          { skillId: 'bridge-idle-usdc', monthlyUsdc: '2.5', activeSubscriptions: 2 },
        ],
      }));
    await __fetchAuthoredSkillsForTests(DEV_WALLET);
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('loaded');
    expect(state.records.map((r) => r.id)).toEqual(['friday-dca', 'bridge-idle-usdc']);
    expect(state.records.map((r) => r.stats?.installs)).toEqual([11, 4]);
    expect(state.records.map((r) => r.monthlyUsdc)).toEqual(['5', '2.5']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [path] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/skills?author=${DEV_WALLET}`);
  });

  it('200 with no records → phase=empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await __fetchAuthoredSkillsForTests(DEV_WALLET);
    expect(__getPanelStateForTests().phase).toBe('empty');
  });

  it('200 with mixed authors filters defensively to the connected wallet', async () => {
    const records = [
      makeRecord({ id: 'mine', authorWallet: DEV_WALLET }),
      makeRecord({ id: 'theirs', authorWallet: OTHER_WALLET }),
    ];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { skills: records.map((record) => record.manifest) }))
      .mockResolvedValueOnce(jsonResponse(200, { snapshot: makeStats({ skillId: 'mine' }) }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authorWallet: DEV_WALLET,
        currency: 'USDC',
        totalMonthlyUsdc: '1',
        skills: [{ skillId: 'mine', monthlyUsdc: '1', activeSubscriptions: 1 }],
      }));
    await __fetchAuthoredSkillsForTests(DEV_WALLET);
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('loaded');
    expect(state.records.map((r) => r.id)).toEqual(['mine']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps rows loaded when some stats or earnings calls are unavailable', async () => {
    const records = [makeRecord({ id: 'mine' })];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { skills: records.map((record) => record.manifest) }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    await __fetchAuthoredSkillsForTests(DEV_WALLET);
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('loaded');
    expect(state.records[0]?.stats).toBeNull();
    expect(state.records[0]?.monthlyUsdc).toBeUndefined();
  });

  it('403 → phase=forbidden', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'dev_layer1_disabled' }));
    await __fetchAuthoredSkillsForTests(DEV_WALLET);
    expect(__getPanelStateForTests().phase).toBe('forbidden');
  });

  it('404 → phase=notDeployed', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await __fetchAuthoredSkillsForTests(DEV_WALLET);
    expect(__getPanelStateForTests().phase).toBe('notDeployed');
  });

  it('500 → phase=error with server message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'internal_error' }));
    await __fetchAuthoredSkillsForTests(DEV_WALLET);
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toContain('internal_error');
  });
});

describe('registry render closure', () => {
  it('registers the Publish sub-tab on module load', () => {
    const ids = listSkillsSubTabs().map((tab) => tab.id);
    expect(ids).toContain('publish');
  });

  it('renders noWallet body when nothing is connected', () => {
    setConnectedAddress(undefined);
    const tab = findSkillsSubTab('publish');
    expect(tab).toBeDefined();
    const html = tab!.render();
    expect(html).toContain('Connect a wallet');
    expect(html).toContain('Publish a skill');
  });

  it('queues a single fetch when the panel mounts twice synchronously', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    setConnectedAddress(DEV_WALLET);
    const tab = findSkillsSubTab('publish')!;
    tab.render();
    tab.render();
    expect(__getKickoffScheduledForTests()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queues a fetch when the wallet connects after a no-wallet render', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const tab = findSkillsSubTab('publish')!;
    setConnectedAddress(undefined);
    expect(tab.render()).toContain('Connect a wallet');
    setConnectedAddress(DEV_WALLET);
    tab.render();
    expect(__getKickoffScheduledForTests()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(__getPanelStateForTests().phase).toBe('empty');
  });

  it('refetches and clears stale authored skills when the connected wallet changes', async () => {
    const first = makeRecord({ id: 'first' });
    const second = makeRecord({ id: 'second', authorWallet: SECOND_WALLET });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { skills: [first.manifest] }))
      .mockResolvedValueOnce(jsonResponse(200, { snapshot: makeStats({ skillId: 'first' }) }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authorWallet: DEV_WALLET,
        currency: 'USDC',
        totalMonthlyUsdc: '1',
        skills: [{ skillId: 'first', monthlyUsdc: '1', activeSubscriptions: 1 }],
      }))
      .mockResolvedValueOnce(jsonResponse(200, { skills: [second.manifest] }))
      .mockResolvedValueOnce(jsonResponse(200, { snapshot: makeStats({ skillId: 'second' }) }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authorWallet: SECOND_WALLET,
        currency: 'USDC',
        totalMonthlyUsdc: '2',
        skills: [{ skillId: 'second', monthlyUsdc: '2', activeSubscriptions: 1 }],
      }));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const tab = findSkillsSubTab('publish')!;
    setConnectedAddress(DEV_WALLET);
    tab.render();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(__getPanelStateForTests().records.map((r) => r.id)).toEqual(['first']);

    setConnectedAddress(SECOND_WALLET);
    tab.render();
    expect(__getPanelStateForTests().records).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(__getPanelStateForTests().records.map((r) => r.id)).toEqual(['second']);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
