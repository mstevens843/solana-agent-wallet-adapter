import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal stubs to let browse.ts load in vitest's default node env. The CSS
// import is gated on `typeof document !== 'undefined'`, so leaving document
// unset prevents the Vite style-injection side effect, while letting us
// import the pure renderers and the fetch wrappers.

import {
  __getStateForTests,
  __resetStateForTests,
  categoryLabel,
  escapeHtml,
  formatInstalls,
  formatMonetization,
  formatSuccessRate,
  handleInstall,
  loadCatalog,
  normalizeCatalog,
  normalizeInstalls,
  normalizeStats,
  requiredInstallParamKeys,
  renderBrowsePanel,
  renderCard,
  type CardRow,
} from '../skills/browse.js';
import { listSkillsSubTabs } from '../skills/subTabRegistry.js';

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
}

function emptyResponse(status: number): Response {
  return new Response('', { status });
}

function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'friday-dca',
    name: 'Friday DCA',
    version: '1.0.0',
    authorWallet: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
    description: 'Buys $50 of SOL every Friday at noon UTC.',
    category: 'dca',
    schedule: { kind: 'cron', spec: '0 12 * * 5' },
    action: { connectorAction: 'jupiter.swap', paramsTemplate: {} },
    caps: {
      perRunMaxAmount: '50',
      lifetimeMaxAmount: '2600',
      allowlistedTokens: ['USDC', 'SOL'],
    },
    ...overrides,
  };
}

const LAUNCH_SKILL_FIXTURES = [
  { id: 'friday-dca', name: 'Friday DCA', category: 'dca' },
  { id: 'yield-auto-rotate', name: 'Yield Auto-Rotate', category: 'yield' },
  { id: 'pyth-stop-loss', name: 'Pyth Stop-Loss', category: 'stops' },
  { id: 'bridge-idle-usdc', name: 'Bridge Idle USDC', category: 'bridge' },
  { id: 'recurring-donation', name: 'Recurring Donation', category: 'donation' },
] as const;

function statsSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skillId: 'friday-dca',
    installs: 12,
    totalExecutions: 47,
    successRate: 0.913,
    computedAt: '2026-05-14T00:00:00Z',
    ...overrides,
  };
}

function installRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inst_1',
    walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
    skillId: 'friday-dca',
    manifestVersion: '1.0.0',
    caps: {
      perRunMaxAmount: '50',
      lifetimeMaxAmount: '2600',
      allowlistedTokens: ['USDC', 'SOL'],
    },
    installedAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    status: 'active',
    ...overrides,
  };
}

describe('pure helpers', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<b>"hi" & \'bye\'</b>')).toBe(
      '&lt;b&gt;&quot;hi&quot; &amp; &#39;bye&#39;&lt;/b&gt;',
    );
  });

  it('formatSuccessRate handles undefined / NaN', () => {
    expect(formatSuccessRate(undefined)).toBe('—');
    expect(formatSuccessRate(null)).toBe('—');
    expect(formatSuccessRate(Number.NaN)).toBe('—');
  });

  it('formatSuccessRate rounds to integer percent', () => {
    expect(formatSuccessRate(0)).toBe('0%');
    expect(formatSuccessRate(0.913)).toBe('91%');
    expect(formatSuccessRate(0.5)).toBe('50%');
    expect(formatSuccessRate(1)).toBe('100%');
    // clamps out-of-range input rather than producing nonsense.
    expect(formatSuccessRate(1.5)).toBe('100%');
    expect(formatSuccessRate(-0.2)).toBe('0%');
  });

  it('formatInstalls pluralizes correctly', () => {
    expect(formatInstalls(undefined)).toBe('—');
    expect(formatInstalls(null)).toBe('—');
    expect(formatInstalls(0)).toBe('0 installs');
    expect(formatInstalls(1)).toBe('1 install');
    expect(formatInstalls(12)).toBe('12 installs');
  });

  it('categoryLabel maps known categories', () => {
    expect(categoryLabel('dca')).toBe('DCA');
    expect(categoryLabel('yield')).toBe('Yield');
    expect(categoryLabel('stops')).toBe('Stops');
    expect(categoryLabel('bridge')).toBe('Bridge');
    expect(categoryLabel('donation')).toBe('Donation');
    expect(categoryLabel('custom')).toBe('Custom');
    // unknown string passes through unchanged.
    expect(categoryLabel('mystery')).toBe('mystery');
  });

  it('formatMonetization handles each kind', () => {
    expect(formatMonetization(undefined)).toBe('');
    expect(
      formatMonetization({ kind: 'one-time', amount: '5', payoutWallet: 'X' }),
    ).toBe('$5 once · paid to author');
    expect(
      formatMonetization({ kind: 'monthly', amount: '2', payoutWallet: 'X' }),
    ).toBe('$2/mo · paid to author');
    expect(
      formatMonetization({ kind: 'performance-fee', feePercent: 10, payoutWallet: 'X' }),
    ).toBe('10% of profit · paid to author');
  });

  it('requiredInstallParamKeys finds install placeholders recursively', () => {
    expect(requiredInstallParamKeys(manifest({
      action: {
        connectorAction: 'prepare_transfer_spl',
        paramsTemplate: {
          recipient: '{{install.recipient}}',
          nested: [{ destinationAddress: '{{install.destinationAddress}}' }],
        },
      },
    }) as unknown as CardRow['manifest'])).toEqual(['destinationAddress', 'recipient']);
  });
});

describe('normalizeCatalog', () => {
  it('accepts a bare array', () => {
    const out = normalizeCatalog([manifest(), manifest({ id: 'b', name: 'Yield' })]);
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe('friday-dca');
  });

  it('accepts { skills: [...] } envelope', () => {
    const out = normalizeCatalog({ skills: [manifest()] });
    expect(out).toHaveLength(1);
  });

  it('accepts { items: [...] } envelope', () => {
    const out = normalizeCatalog({ items: [manifest()] });
    expect(out).toHaveLength(1);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const out = normalizeCatalog([manifest(), null, 'junk', { id: 5 }, manifest({ id: 'ok2' })]);
    expect(out.map((m) => m.id)).toEqual(['friday-dca', 'ok2']);
  });

  it('returns [] for garbage', () => {
    expect(normalizeCatalog(null)).toEqual([]);
    expect(normalizeCatalog('nope')).toEqual([]);
    expect(normalizeCatalog({})).toEqual([]);
  });
});

describe('normalizeInstalls', () => {
  it('accepts a bare array', () => {
    expect(normalizeInstalls([installRecord()])).toHaveLength(1);
  });

  it('accepts { installs: [...] } envelope', () => {
    expect(normalizeInstalls({ installs: [installRecord()] })).toHaveLength(1);
  });

  it('drops malformed entries', () => {
    const out = normalizeInstalls([installRecord(), { id: 'x' }, null]);
    expect(out).toHaveLength(1);
  });
});

describe('normalizeStats', () => {
  it('passes through a bare snapshot', () => {
    const s = statsSnapshot();
    expect(normalizeStats(s)).toEqual(s);
  });

  it('unwraps { snapshot: ... }', () => {
    expect(normalizeStats({ snapshot: statsSnapshot() })?.skillId).toBe('friday-dca');
  });

  it('unwraps { stats: ... }', () => {
    expect(normalizeStats({ stats: statsSnapshot() })?.skillId).toBe('friday-dca');
  });

  it('returns null for garbage', () => {
    expect(normalizeStats(null)).toBeNull();
    expect(normalizeStats({ error: 'oops' })).toBeNull();
    expect(normalizeStats({ snapshot: { foo: 'bar' } })).toBeNull();
  });
});

describe('renderBrowsePanel', () => {
  beforeEach(() => {
    __resetStateForTests({ phase: 'ready', rows: [] });
  });

  it('renders the root with the data attribute and a refresh button', () => {
    const html = renderBrowsePanel();
    expect(html).toContain('data-skills-browse-root');
    expect(html).toContain('data-skills-browse-action="refresh"');
    expect(html).toContain('Browse skills');
  });

  it('phase idle → shows the loading shell', () => {
    __resetStateForTests({ phase: 'idle' });
    const html = renderBrowsePanel();
    expect(html).toContain('Loading skills…');
    expect(html).not.toContain('skills-browse-grid');
  });

  it('phase ready with 0 rows → shows the empty state', () => {
    __resetStateForTests({ phase: 'ready', rows: [] });
    const html = renderBrowsePanel();
    expect(html).toContain('No skills published yet');
  });

  it('phase ready with rows → renders one card per row with data-skill-id', () => {
    const rows: CardRow[] = [
      {
        manifest: manifest() as unknown as CardRow['manifest'],
        stats: null,
        installStatus: 'none',
      },
      {
        manifest: manifest({ id: 'yield-auto-rotate', name: 'Yield Rotate' }) as unknown as CardRow['manifest'],
        stats: null,
        installStatus: 'none',
      },
    ];
    __resetStateForTests({ phase: 'ready', rows });
    const html = renderBrowsePanel();
    expect(html).toContain('data-skill-id="friday-dca"');
    expect(html).toContain('data-skill-id="yield-auto-rotate"');
    expect(html.match(/data-skills-browse-action="install"/g) ?? []).toHaveLength(2);
  });

  it('row with installStatus=active → renders Installed chip, no install button', () => {
    const rows: CardRow[] = [
      {
        manifest: manifest() as unknown as CardRow['manifest'],
        stats: null,
        installStatus: 'active',
      },
    ];
    __resetStateForTests({ phase: 'ready', rows });
    const html = renderBrowsePanel();
    expect(html).toContain('skills-browse-installed');
    expect(html).not.toContain('data-skills-browse-action="install"');
  });

  it('busyInstallId matches a row → that row\'s button is disabled with Installing… label', () => {
    const rows: CardRow[] = [
      {
        manifest: manifest() as unknown as CardRow['manifest'],
        stats: null,
        installStatus: 'none',
      },
    ];
    __resetStateForTests({ phase: 'ready', rows, busyInstallId: 'friday-dca' });
    const html = renderBrowsePanel();
    expect(html).toContain('Installing…');
    expect(html).toContain('disabled');
  });

  it('error → renders banner with dismiss button', () => {
    __resetStateForTests({ phase: 'error', error: 'boom' });
    const html = renderBrowsePanel();
    expect(html).toContain('skills-browse-error');
    expect(html).toContain('boom');
    expect(html).toContain('data-skills-browse-action="dismiss-error"');
  });

  it('notice → renders banner with dismiss button', () => {
    __resetStateForTests({
      phase: 'ready',
      notice: { title: 'API unavailable', body: 'Backend returned 404.' },
    });
    const html = renderBrowsePanel();
    expect(html).toContain('skills-browse-notice');
    expect(html).toContain('API unavailable');
    expect(html).toContain('data-skills-browse-action="dismiss-notice"');
  });
});

describe('renderCard', () => {
  it('shows stats from snapshot when present', () => {
    const row: CardRow = {
      manifest: manifest() as unknown as CardRow['manifest'],
      stats: statsSnapshot() as unknown as CardRow['stats'],
      installStatus: 'none',
    };
    const html = renderCard(row, null);
    expect(html).toContain('12 installs');
    expect(html).toContain('91%');
    expect(html).toContain('Friday DCA');
    expect(html).toContain('DCA');
  });

  it('shows em dashes when stats are missing', () => {
    const row: CardRow = {
      manifest: manifest() as unknown as CardRow['manifest'],
      stats: null,
      installStatus: 'none',
    };
    const html = renderCard(row, null);
    // both Installs and Success cells render an em dash.
    expect((html.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('shows monetization line when manifest has monetization', () => {
    const row: CardRow = {
      manifest: manifest({
        monetization: { kind: 'monthly', amount: '2', payoutWallet: 'X' },
      }) as unknown as CardRow['manifest'],
      stats: null,
      installStatus: 'none',
    };
    const html = renderCard(row, null);
    expect(html).toContain('$2/mo');
  });

  it('renders install-time inputs for manifests with install placeholders', () => {
    const row: CardRow = {
      manifest: manifest({
        action: {
          connectorAction: 'prepare_transfer_spl',
          paramsTemplate: { token: 'USDC', recipient: '{{install.recipient}}', amount: '10' },
        },
      }) as unknown as CardRow['manifest'],
      stats: null,
      installStatus: 'none',
    };
    const html = renderCard(row, null);
    expect(html).toContain('data-install-param-key="recipient"');
    expect(html).toContain('Recipient');
  });
});

describe('loadCatalog', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    __resetStateForTests();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  function routeFetch(handlers: {
    catalog?: () => Response;
    installs?: () => Response;
    stats?: (id: string) => Response;
  }): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/skills') {
        return handlers.catalog?.() ?? jsonResponse(200, []);
      }
      if (url === '/api/skills/installs') {
        return handlers.installs?.() ?? jsonResponse(200, []);
      }
      const m = url.match(/^\/api\/aggregator\/skills\/(.+)$/);
      if (m) {
        return handlers.stats?.(decodeURIComponent(m[1]!)) ?? jsonResponse(404, {});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it('200 catalog + 200 installs + 200 stats → state is ready with stats populated', async () => {
    routeFetch({
      catalog: () => jsonResponse(200, [manifest(), manifest({ id: 'yield-auto-rotate' })]),
      installs: () => jsonResponse(200, []),
      stats: (id) => jsonResponse(200, statsSnapshot({ skillId: id })),
    });
    await loadCatalog();
    const s = __getStateForTests();
    expect(s.phase).toBe('ready');
    expect(s.rows).toHaveLength(2);
    expect(s.rows[0]!.stats?.skillId).toBe('friday-dca');
    expect(s.rows[1]!.stats?.skillId).toBe('yield-auto-rotate');
  });

  it('renders all five launch skills with stats and install buttons', async () => {
    routeFetch({
      catalog: () => jsonResponse(200, LAUNCH_SKILL_FIXTURES.map((m) => manifest(m))),
      installs: () => jsonResponse(200, []),
      stats: (id) => jsonResponse(200, statsSnapshot({ skillId: id, installs: 7, successRate: 0.875 })),
    });
    await loadCatalog();
    const s = __getStateForTests();
    expect(s.rows).toHaveLength(5);

    const html = renderBrowsePanel();
    for (const skill of LAUNCH_SKILL_FIXTURES) {
      expect(html).toContain(`data-skill-id="${skill.id}"`);
      expect(html).toContain(skill.name);
    }
    expect(html.match(/class="skills-browse-card"/g) ?? []).toHaveLength(5);
    expect(html.match(/data-skills-browse-action="install"/g) ?? []).toHaveLength(5);
    expect(html).toContain('7 installs');
    expect(html).toContain('88%');
  });

  it('ignores stale catalog responses when overlapping refreshes resolve out of order', async () => {
    const firstCatalog = deferredResponse();
    const firstInstalls = deferredResponse();
    let catalogCalls = 0;
    let installsCalls = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/skills') {
        catalogCalls += 1;
        if (catalogCalls === 1) return firstCatalog.promise;
        return jsonResponse(200, [manifest({ id: 'fresh-skill', name: 'Fresh Skill' })]);
      }
      if (url === '/api/skills/installs') {
        installsCalls += 1;
        if (installsCalls === 1) return firstInstalls.promise;
        return jsonResponse(200, []);
      }
      const m = url.match(/^\/api\/aggregator\/skills\/(.+)$/);
      if (m) {
        return jsonResponse(200, statsSnapshot({ skillId: decodeURIComponent(m[1]!) }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const staleLoad = loadCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const freshLoad = loadCatalog();
    await freshLoad;
    expect(__getStateForTests().rows.map((row) => row.manifest.id)).toEqual(['fresh-skill']);

    firstCatalog.resolve(jsonResponse(200, [manifest({ id: 'stale-skill', name: 'Stale Skill' })]));
    firstInstalls.resolve(jsonResponse(200, []));
    await staleLoad;

    expect(__getStateForTests().rows.map((row) => row.manifest.id)).toEqual(['fresh-skill']);
    const html = renderBrowsePanel();
    expect(html).toContain('Fresh Skill');
    expect(html).not.toContain('Stale Skill');
  });

  it('unwraps { skills: [...] } envelope from /api/skills', async () => {
    routeFetch({
      catalog: () => jsonResponse(200, { skills: [manifest()] }),
    });
    await loadCatalog();
    expect(__getStateForTests().rows).toHaveLength(1);
  });

  it('403 catalog → forbidden notice, phase ready, rows empty', async () => {
    routeFetch({ catalog: () => emptyResponse(403) });
    await loadCatalog();
    const s = __getStateForTests();
    expect(s.phase).toBe('ready');
    expect(s.notice?.title).toBe('Dev gate active');
    expect(s.rows).toHaveLength(0);
  });

  it('404 catalog → notDeployed notice, phase ready, rows empty', async () => {
    routeFetch({ catalog: () => emptyResponse(404) });
    await loadCatalog();
    const s = __getStateForTests();
    expect(s.phase).toBe('ready');
    expect(s.notice?.title).toBe('Skills API unavailable');
  });

  it('500 catalog → phase error with message', async () => {
    routeFetch({ catalog: () => jsonResponse(500, { error: 'kaboom' }) });
    await loadCatalog();
    const s = __getStateForTests();
    expect(s.phase).toBe('error');
    expect(s.error).toBe('kaboom');
  });

  it('200 catalog + 404 stats per row → rows render with null stats', async () => {
    routeFetch({
      catalog: () => jsonResponse(200, [manifest()]),
      installs: () => jsonResponse(200, []),
      stats: () => emptyResponse(404),
    });
    await loadCatalog();
    const s = __getStateForTests();
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.stats).toBeNull();
  });

  it('200 catalog + 200 installs containing the id → row.installStatus reflects status', async () => {
    routeFetch({
      catalog: () => jsonResponse(200, [manifest()]),
      installs: () => jsonResponse(200, [installRecord({ status: 'active' })]),
      stats: () => jsonResponse(404, {}),
    });
    await loadCatalog();
    const s = __getStateForTests();
    expect(s.rows[0]!.installStatus).toBe('active');
  });

  it('200 catalog + forbidden installs → still renders cards as not-installed', async () => {
    routeFetch({
      catalog: () => jsonResponse(200, [manifest()]),
      installs: () => emptyResponse(403),
    });
    await loadCatalog();
    const s = __getStateForTests();
    expect(s.rows[0]!.installStatus).toBe('none');
  });
});

describe('handleInstall', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    __resetStateForTests({
      phase: 'ready',
      rows: [
        {
          manifest: manifest() as unknown as CardRow['manifest'],
          stats: null,
          installStatus: 'none',
        },
      ],
    });
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it('sends body { skillId, manifestVersion, caps, acceptMonetization } and flips status to active on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { installId: 'inst_xyz' }));
    await handleInstall('friday-dca');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/skills/installs');
    const initObj = init as RequestInit;
    expect(initObj.method).toBe('POST');
    const body = JSON.parse(initObj.body as string) as {
      skillId: string;
      manifestVersion: string;
      caps: { perRunMaxAmount: string };
      acceptMonetization: boolean;
    };
    expect(body.skillId).toBe('friday-dca');
    expect(body.manifestVersion).toBe('1.0.0');
    expect(body.caps.perRunMaxAmount).toBe('50');
    expect(body.acceptMonetization).toBe(true);
    const s = __getStateForTests();
    expect(s.rows[0]!.installStatus).toBe('active');
    expect(s.busyInstallId).toBeNull();
  });

  it('requires install-time params before posting', async () => {
    __resetStateForTests({
      phase: 'ready',
      rows: [
        {
          manifest: manifest({
            action: {
              connectorAction: 'prepare_transfer_spl',
              paramsTemplate: { token: 'USDC', recipient: '{{install.recipient}}', amount: '10' },
            },
          }) as unknown as CardRow['manifest'],
          stats: null,
          installStatus: 'none',
        },
      ],
    });
    await handleInstall('friday-dca');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(__getStateForTests().installParamErrors['friday-dca']).toBe('Recipient is required.');
  });

  it('posts install-time params and mirrors recipient into caps', async () => {
    __resetStateForTests({
      phase: 'ready',
      rows: [
        {
          manifest: manifest({
            action: {
              connectorAction: 'prepare_transfer_spl',
              paramsTemplate: { token: 'USDC', recipient: '{{install.recipient}}', amount: '10' },
            },
          }) as unknown as CardRow['manifest'],
          stats: null,
          installStatus: 'none',
        },
      ],
      installParamDrafts: {
        'friday-dca': {
          recipient: 'Recipient111111111111111111111111111111111',
        },
      },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { installId: 'inst_xyz' }));
    await handleInstall('friday-dca');
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      installParams: Record<string, string>;
      caps: { allowlistedRecipients?: string[] };
    };
    expect(body.installParams).toEqual({
      recipient: 'Recipient111111111111111111111111111111111',
    });
    expect(body.caps.allowlistedRecipients).toContain('Recipient111111111111111111111111111111111');
  });

  it('403 → notice set, row unchanged, busy cleared', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(403));
    await handleInstall('friday-dca');
    const s = __getStateForTests();
    expect(s.notice?.title).toBe('Dev gate active');
    expect(s.rows[0]!.installStatus).toBe('none');
    expect(s.busyInstallId).toBeNull();
  });

  it('404 → notDeployed notice', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(404));
    await handleInstall('friday-dca');
    expect(__getStateForTests().notice?.title).toBe('Skills API unavailable');
  });

  it('500 with { error } → state.error captures the message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'oops' }));
    await handleInstall('friday-dca');
    const s = __getStateForTests();
    expect(s.error).toBe('oops');
    expect(s.rows[0]!.installStatus).toBe('none');
  });

  it('single-flight: second concurrent call returns without firing fetch', async () => {
    // First call: pending Promise that never resolves until we choose.
    let resolveFirst: ((value: Response) => void) | null = null;
    const firstPromise = new Promise<Response>((res) => {
      resolveFirst = res;
    });
    fetchMock.mockReturnValueOnce(firstPromise);

    const firstCall = handleInstall('friday-dca');
    // Yield once so handleInstall reaches its await.
    await Promise.resolve();
    expect(__getStateForTests().busyInstallId).toBe('friday-dca');

    // Second call while busy: should bail without firing fetch.
    await handleInstall('friday-dca');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve the first.
    resolveFirst!(jsonResponse(200, { installId: 'inst_xyz' }));
    await firstCall;
    expect(__getStateForTests().busyInstallId).toBeNull();
  });

  it('unknown skillId → returns without firing fetch', async () => {
    await handleInstall('does-not-exist');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('registry side effect', () => {
  it('importing browse.ts registers the Browse sub-tab', () => {
    const tabs = listSkillsSubTabs();
    const browse = tabs.find((t) => t.id === 'browse');
    expect(browse).toBeDefined();
    expect(browse?.label).toBe('Browse');
    expect(typeof browse?.render).toBe('function');
  });
});
