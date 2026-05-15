import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __getStateForTests,
  __resetStateForTests,
  escapeHtml,
  formatRecentCount,
  handleAction,
  handlePause,
  handleResume,
  handleUninstall,
  humanizeRelative,
  humanizeSchedule,
  humanizeSeconds,
  invalidateInstalledCache,
  loadInstalls,
  normalizeCatalogResponse,
  normalizeInstallsResponse,
  renderInstalledPanel,
  renderRow,
  shortAddress,
  statusModifier,
  type InstallRow,
  type RowRenderOptions,
} from '../skills/installed.js';

type FetchMock = ReturnType<typeof vi.fn>;

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setFetchSequence(responses: Array<{ status: number; body: unknown }>): FetchMock {
  const queue = [...responses];
  const mock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('fetch called more times than expected');
    return makeJsonResponse(next.status, next.body);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function defaultRowOpts(overrides: Partial<RowRenderOptions> = {}): RowRenderOptions {
  return {
    busyInstallId: null,
    pendingUninstallId: null,
    pendingUninstallExpiresAt: 0,
    nowMs: Date.parse('2026-05-14T12:00:00.000Z'),
    ...overrides,
  };
}

function makeInstall(
  overrides: Partial<{
    id: string;
    skillId: string;
    status: string;
    monetizationScheduleId: string;
  }> = {},
): InstallRow {
  return {
    install: {
      id: overrides.id ?? 'inst_001',
      walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
      skillId: overrides.skillId ?? 'friday-dca',
      manifestVersion: '1.0.0',
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC'],
      },
      installedAt: '2026-05-14T10:00:00.000Z',
      updatedAt: '2026-05-14T10:00:00.000Z',
      status: (overrides.status ?? 'active') as 'active' | 'paused' | 'expired' | 'revoked',
      ...(overrides.monetizationScheduleId ? { monetizationScheduleId: overrides.monetizationScheduleId } : {}),
    },
    manifest: {
      id: overrides.skillId ?? 'friday-dca',
      name: 'Friday DCA',
      version: '1.0.0',
      authorWallet: 'AUTHWALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      description: 'Buy SOL every Friday at 09:00 UTC',
      category: 'dca',
      schedule: { kind: 'cron', spec: '0 9 * * 5' },
      action: { connectorAction: 'jupiter.swap', paramsTemplate: {} },
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC'],
      },
    },
    recentExecutionCount: 3,
  };
}

beforeEach(() => {
  __resetStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pure helpers', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<b>"a" & \'b\'</b>')).toBe(
      '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;',
    );
  });

  it('shortens long addresses', () => {
    expect(shortAddress('4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd')).toBe('4fTq…MoHd');
    expect(shortAddress('short')).toBe('short');
    expect(shortAddress('')).toBe('');
  });

  it('formatRecentCount handles missing, zero, one, many', () => {
    expect(formatRecentCount(undefined)).toBe('7d: —');
    expect(formatRecentCount(null as unknown as undefined)).toBe('7d: —');
    expect(formatRecentCount(Number.NaN)).toBe('7d: —');
    expect(formatRecentCount(0)).toBe('7d: 0 runs');
    expect(formatRecentCount(1)).toBe('7d: 1 run');
    expect(formatRecentCount(12)).toBe('7d: 12 runs');
  });

  it('statusModifier maps every known status', () => {
    expect(statusModifier('active')).toBe('is-active');
    expect(statusModifier('paused')).toBe('is-paused');
    expect(statusModifier('expired')).toBe('is-expired');
    expect(statusModifier('revoked')).toBe('is-revoked');
    expect(statusModifier('unknown')).toBe('is-expired');
  });
});

describe('humanizeSchedule', () => {
  it('humanizes whitelisted cron patterns', () => {
    expect(humanizeSchedule({ kind: 'cron', spec: '* * * * *' })).toBe('Every minute');
    expect(humanizeSchedule({ kind: 'cron', spec: '0 * * * *' })).toBe('Every hour');
    expect(humanizeSchedule({ kind: 'cron', spec: '0 0 * * *' })).toBe('Daily at 00:00 UTC');
    expect(humanizeSchedule({ kind: 'cron', spec: '0 9 * * 1-5' })).toBe('Weekdays at 09:00 UTC');
  });

  it('falls back to cron(spec) for unrecognized cron expressions', () => {
    expect(humanizeSchedule({ kind: 'cron', spec: '7 13 * * 3' })).toBe('cron(7 13 * * 3)');
  });

  it('humanizes interval kind', () => {
    expect(humanizeSchedule({ kind: 'interval', spec: '60s' })).toBe('Every minute');
    expect(humanizeSchedule({ kind: 'interval', spec: '15m' })).toBe('Every 15m');
    expect(humanizeSchedule({ kind: 'interval', spec: '2h' })).toBe('Every 2h');
    expect(humanizeSchedule({ kind: 'interval', spec: '7d' })).toBe('Every week');
    expect(humanizeSchedule({ kind: 'interval', spec: 'P1W' })).toBe('Every week');
    expect(humanizeSchedule({ kind: 'interval', spec: 'PT15M' })).toBe('Every 15m');
    expect(humanizeSchedule({ kind: 'interval', spec: '60' })).toBe('Every minute');
    expect(humanizeSchedule({ kind: 'interval', spec: '3600' })).toBe('Every hour');
    expect(humanizeSchedule({ kind: 'interval', spec: '86400' })).toBe('Every day');
    expect(humanizeSchedule({ kind: 'interval', spec: '604800' })).toBe('Every week');
    expect(humanizeSchedule({ kind: 'interval', spec: '300' })).toBe('Every 5m');
    expect(humanizeSchedule({ kind: 'interval', spec: 'soon-ish' })).toBe('Interval(soon-ish)');
  });

  it('handles price-trigger kind', () => {
    expect(humanizeSchedule({ kind: 'price-trigger', spec: 'SOL>200' })).toBe('On price trigger');
  });

  it('returns Schedule unavailable when missing', () => {
    expect(humanizeSchedule(undefined)).toBe('Schedule unavailable');
    expect(humanizeSchedule(null)).toBe('Schedule unavailable');
  });
});

describe('humanizeSeconds', () => {
  it('formats common units', () => {
    expect(humanizeSeconds(60)).toBe('Every minute');
    expect(humanizeSeconds(3600)).toBe('Every hour');
    expect(humanizeSeconds(86_400)).toBe('Every day');
    expect(humanizeSeconds(604_800)).toBe('Every week');
    expect(humanizeSeconds(120)).toBe('Every 2m');
    expect(humanizeSeconds(45)).toBe('Every 45s');
  });

  it('returns dash for non-positive', () => {
    expect(humanizeSeconds(0)).toBe('—');
    expect(humanizeSeconds(-5)).toBe('—');
    expect(humanizeSeconds(Number.NaN)).toBe('—');
  });
});

describe('humanizeRelative', () => {
  const now = Date.parse('2026-05-14T12:00:00.000Z');

  it('formats future offsets', () => {
    expect(humanizeRelative('2026-05-14T12:00:30.000Z', now)).toBe('in <1m');
    expect(humanizeRelative('2026-05-14T12:30:00.000Z', now)).toBe('in 30m');
    expect(humanizeRelative('2026-05-14T15:00:00.000Z', now)).toBe('in 3h');
    expect(humanizeRelative('2026-05-17T12:00:00.000Z', now)).toBe('in 3d');
  });

  it('formats past offsets', () => {
    expect(humanizeRelative('2026-05-14T11:30:00.000Z', now)).toBe('30m ago');
    expect(humanizeRelative('2026-05-14T09:00:00.000Z', now)).toBe('3h ago');
    expect(humanizeRelative('2026-05-12T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('returns the input when not a date', () => {
    expect(humanizeRelative('not-a-date', now)).toBe('not-a-date');
  });
});

describe('normalizers', () => {
  it('normalizeInstallsResponse accepts { installRows }, { installs }, [], { items }, and { install, manifest } envelope', () => {
    const installArray = [makeInstall().install];
    const installRows = [
      {
        install: installArray[0],
        manifest: makeInstall().manifest,
        recentExecutionCount: 4,
        lastExecutionAt: '2026-05-13T00:00:00.000Z',
        nextRunAt: '2026-05-15T09:00:00.000Z',
        recurringScheduleStatus: 'active',
      },
    ];
    const normalizedRows = normalizeInstallsResponse({ installRows });
    expect(normalizedRows).toHaveLength(1);
    expect(normalizedRows[0]!.recentExecutionCount).toBe(4);
    expect(normalizedRows[0]!.recurringScheduleStatus).toBe('active');
    expect(normalizeInstallsResponse({ installs: installArray })).toHaveLength(1);
    expect(normalizeInstallsResponse(installArray)).toHaveLength(1);
    expect(normalizeInstallsResponse({ items: installArray })).toHaveLength(1);
    expect(normalizeInstallsResponse({})).toEqual([]);

    const wrapped = [
      {
        install: installArray[0],
        manifest: makeInstall().manifest,
        recentExecutionCount: 9,
        lastExecutionAt: '2026-05-13T00:00:00.000Z',
        nextRunAt: '2026-05-15T09:00:00.000Z',
      },
    ];
    const rows = normalizeInstallsResponse(wrapped);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.manifest?.name).toBe('Friday DCA');
    expect(rows[0]!.recentExecutionCount).toBe(9);
    expect(rows[0]!.nextRunAt).toBe('2026-05-15T09:00:00.000Z');
  });

  it('normalizeInstallsResponse drops invalid entries', () => {
    const mixed = [
      { id: 'no-skillid' },
      'garbage',
      null,
      makeInstall().install,
    ];
    expect(normalizeInstallsResponse(mixed)).toHaveLength(1);
  });

  it('normalizeInstallsResponse drops revoked installs from UI rows', () => {
    const rows = normalizeInstallsResponse({
      installs: [
        makeInstall({ id: 'active_install' }).install,
        makeInstall({ id: 'revoked_install', status: 'revoked' }).install,
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.install.id).toBe('active_install');
  });

  it('normalizeCatalogResponse accepts { skills }, [], { items }', () => {
    const m = makeInstall().manifest!;
    expect(normalizeCatalogResponse({ skills: [m] })).toHaveLength(1);
    expect(normalizeCatalogResponse([m])).toHaveLength(1);
    expect(normalizeCatalogResponse({ items: [m] })).toHaveLength(1);
    expect(normalizeCatalogResponse(null)).toEqual([]);
  });
});

describe('renderInstalledPanel branches', () => {
  it('renders loading skeleton when phase=loading and no rows', () => {
    __resetStateForTests({ phase: 'loading' });
    const html = renderInstalledPanel();
    expect(html).toContain('data-skills-installed-root');
    expect(html).toContain('Loading installed skills…');
  });

  it('renders forbidden notice', () => {
    __resetStateForTests({
      phase: 'ready',
      notice: { title: 'Dev gate active', body: 'Connect the allowed dev wallet to manage installed skills.' },
    });
    const html = renderInstalledPanel();
    expect(html).toContain('is-forbidden');
    expect(html).toContain('Dev gate active');
  });

  it('renders notDeployed notice', () => {
    __resetStateForTests({
      phase: 'ready',
      notice: { title: 'Skills API unavailable', body: '/api/skills/installs returned 404.' },
    });
    const html = renderInstalledPanel();
    expect(html).toContain('is-not-deployed');
    expect(html).toContain('Skills API unavailable');
  });

  it('renders error banner when phase=error', () => {
    __resetStateForTests({ phase: 'error', error: 'kaboom' });
    const html = renderInstalledPanel();
    expect(html).toContain('Something went wrong');
    expect(html).toContain('kaboom');
    expect(html).toContain('data-skills-installed-action="dismiss-error"');
  });

  it('renders empty state with browse link when ready and no rows', () => {
    __resetStateForTests({ phase: 'ready', rows: [] });
    const html = renderInstalledPanel();
    expect(html).toContain('No skills installed yet');
    expect(html).toContain('data-skills-installed-action="go-browse"');
  });

  it('renders rows with the correct status modifier per row', () => {
    const rows: InstallRow[] = [
      makeInstall({ id: 'a', status: 'active' }),
      makeInstall({ id: 'b', status: 'paused' }),
      makeInstall({ id: 'c', status: 'expired' }),
      makeInstall({ id: 'd', status: 'revoked' }),
    ];
    __resetStateForTests({ phase: 'ready', rows });
    const html = renderInstalledPanel();
    expect(html).toContain('skills-installed-row-status is-active');
    expect(html).toContain('skills-installed-row-status is-paused');
    expect(html).toContain('skills-installed-row-status is-expired');
    expect(html).toContain('skills-installed-row-status is-revoked');
  });

  it('shows silent-refetch spinner when silentRefetching=true', () => {
    __resetStateForTests({ phase: 'ready', rows: [makeInstall()], silentRefetching: true });
    expect(renderInstalledPanel()).toContain('skills-installed-spinner');
  });
});

describe('renderRow specifics', () => {
  it('falls back to "Skill <short id>" when manifest is missing', () => {
    const row: InstallRow = { install: makeInstall().install };
    const html = renderRow(row, defaultRowOpts());
    expect(html).toContain('Skill ');
    expect(html).toContain('Schedule unavailable');
    expect(html).toContain('7d: —');
  });

  it('toggle button reads "Resume" when status=paused', () => {
    const row = makeInstall({ status: 'paused' });
    const html = renderRow(row, defaultRowOpts());
    expect(html).toContain('data-skills-installed-action="resume"');
    expect(html).toContain('>Resume<');
  });

  it('toggle button reads "Pause" when status=active', () => {
    const row = makeInstall({ status: 'active' });
    const html = renderRow(row, defaultRowOpts());
    expect(html).toContain('data-skills-installed-action="pause"');
    expect(html).toContain('>Pause<');
  });

  it('omits toggle button for expired/revoked', () => {
    expect(renderRow(makeInstall({ status: 'expired' }), defaultRowOpts())).not.toContain(
      'data-skills-installed-action="pause"',
    );
    expect(renderRow(makeInstall({ status: 'revoked' }), defaultRowOpts())).not.toContain(
      'data-skills-installed-action="resume"',
    );
  });

  it('uninstall button shows confirm copy when armed', () => {
    const row = makeInstall({ id: 'inst_x' });
    const opts = defaultRowOpts({
      pendingUninstallId: 'inst_x',
      pendingUninstallExpiresAt: defaultRowOpts().nowMs + 1000,
    });
    const html = renderRow(row, opts);
    expect(html).toContain('is-confirming');
    expect(html).toContain('Click again to confirm');
  });

  it('row gets is-busy class when actionInFlight matches install id', () => {
    const row = makeInstall({ id: 'inst_y' });
    const html = renderRow(row, defaultRowOpts({ busyInstallId: 'inst_y' }));
    expect(html).toContain('skills-installed-row is-busy');
  });

  it('renders Next run line when nextRunAt is supplied', () => {
    const row: InstallRow = {
      ...makeInstall(),
      nextRunAt: '2026-05-14T15:00:00.000Z',
    };
    const html = renderRow(row, defaultRowOpts());
    expect(html).toContain('Next run in 3h');
  });
});

describe('loadInstalls', () => {
  it('joins installs with the catalog manifest by skillId', async () => {
    const installRecord = makeInstall().install;
    const manifest = makeInstall().manifest!;
    setFetchSequence([
      { status: 200, body: { installs: [installRecord] } },
      { status: 200, body: { skills: [manifest] } },
    ]);
    await loadInstalls();
    const s = __getStateForTests();
    expect(s.phase).toBe('ready');
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.manifest?.name).toBe('Friday DCA');
    expect(s.fetchedAt).toBeGreaterThan(0);
    expect(s.silentRefetching).toBe(false);
  });

  it('prefers server-enriched installRows over raw installs', async () => {
    const row = {
      install: makeInstall({ id: 'inst_enriched' }).install,
      manifest: makeInstall().manifest,
      recentExecutionCount: 6,
      lastExecutionAt: '2026-05-13T00:00:00.000Z',
      nextRunAt: '2026-05-15T09:00:00.000Z',
    };
    setFetchSequence([
      {
        status: 200,
        body: {
          installs: [makeInstall({ id: 'raw_install' }).install],
          installRows: [row],
        },
      },
      { status: 200, body: { skills: [] } },
    ]);
    await loadInstalls();
    const s = __getStateForTests();
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.install.id).toBe('inst_enriched');
    expect(s.rows[0]!.recentExecutionCount).toBe(6);
    expect(s.rows[0]!.nextRunAt).toBe('2026-05-15T09:00:00.000Z');
  });

  it('renders forbidden notice when GET returns 403', async () => {
    setFetchSequence([
      { status: 403, body: { error: 'forbidden' } },
      { status: 403, body: { error: 'forbidden' } },
    ]);
    await loadInstalls();
    const s = __getStateForTests();
    expect(s.phase).toBe('ready');
    expect(s.notice?.title).toBe('Dev gate active');
    expect(s.rows).toEqual([]);
  });

  it('renders notDeployed notice when GET returns 404', async () => {
    setFetchSequence([
      { status: 404, body: {} },
      { status: 404, body: {} },
    ]);
    await loadInstalls();
    const s = __getStateForTests();
    expect(s.phase).toBe('ready');
    expect(s.notice?.title).toBe('Skills API unavailable');
  });

  it('flips phase=error when GET returns 500', async () => {
    setFetchSequence([
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
    ]);
    await loadInstalls();
    const s = __getStateForTests();
    expect(s.phase).toBe('error');
    expect(s.error).toContain('boom');
  });
});

describe('install-change invalidation', () => {
  it('resets cached empty Installed state so the next tab entry loads fresh data', () => {
    __resetStateForTests({
      phase: 'ready',
      rows: [],
      fetchedAt: Date.now(),
      silentRefetching: false,
      error: 'stale',
      notice: { title: 'Old', body: 'Old notice' },
      actionError: 'old action error',
    });
    invalidateInstalledCache();
    const state = __getStateForTests();
    expect(state.phase).toBe('idle');
    expect(state.fetchedAt).toBe(0);
    expect(state.error).toBe('');
    expect(state.notice).toBeNull();
    expect(state.actionError).toBe('');
  });
});

describe('handleAction routing', () => {
  it('refresh triggers a fetch sequence', async () => {
    const mock = setFetchSequence([
      { status: 200, body: { installs: [] } },
      { status: 200, body: { skills: [] } },
    ]);
    await handleAction('refresh');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0]![0]).toBe('/api/skills/installs');
    expect(mock.mock.calls[1]![0]).toBe('/api/skills');
  });

  it('dismiss-error clears state.error', async () => {
    __resetStateForTests({ phase: 'error', error: 'oops' });
    await handleAction('dismiss-error');
    expect(__getStateForTests().error).toBe('');
  });

  it('dismiss-action-error clears state.actionError', async () => {
    __resetStateForTests({ phase: 'ready', actionError: 'failed' });
    await handleAction('dismiss-action-error');
    expect(__getStateForTests().actionError).toBe('');
  });

  it('unknown action is a no-op', async () => {
    __resetStateForTests({ phase: 'ready', error: 'kept' });
    await handleAction('not-a-real-action');
    expect(__getStateForTests().error).toBe('kept');
  });
});

describe('pause / resume', () => {
  it('pause POSTs to /pause then refetches the list', async () => {
    __resetStateForTests({ phase: 'ready', rows: [makeInstall({ id: 'inst_pp' })] });
    const mock = setFetchSequence([
      { status: 200, body: { install: makeInstall({ status: 'paused' }).install } },
      { status: 200, body: { installs: [makeInstall({ id: 'inst_pp', status: 'paused' }).install] } },
      { status: 200, body: { skills: [makeInstall().manifest] } },
    ]);
    await handlePause('inst_pp');
    expect(mock).toHaveBeenCalledTimes(3);
    const [postCall, getInstallsCall, getCatalogCall] = mock.mock.calls;
    expect(postCall![0]).toBe('/api/skills/installs/inst_pp/pause');
    expect((postCall![1] as RequestInit).method).toBe('POST');
    expect(getInstallsCall![0]).toBe('/api/skills/installs');
    expect(getCatalogCall![0]).toBe('/api/skills');
    expect(__getStateForTests().actionInFlight).toBeNull();
    expect(__getStateForTests().rows[0]!.install.status).toBe('paused');
  });

  it('resume POSTs to /resume', async () => {
    __resetStateForTests({ phase: 'ready', rows: [makeInstall({ id: 'inst_r', status: 'paused' })] });
    const mock = setFetchSequence([
      { status: 200, body: { install: makeInstall().install } },
      { status: 200, body: { installs: [makeInstall({ id: 'inst_r', status: 'active' }).install] } },
      { status: 200, body: { skills: [makeInstall().manifest] } },
    ]);
    await handleResume('inst_r');
    expect(mock.mock.calls[0]![0]).toBe('/api/skills/installs/inst_r/resume');
  });

  it('blocks duplicate clicks while a mutation is in flight', async () => {
    __resetStateForTests({ phase: 'ready', actionInFlight: 'busy_id', rows: [makeInstall({ id: 'busy_id' })] });
    const mock = vi.fn();
    globalThis.fetch = mock as unknown as typeof fetch;
    await handlePause('busy_id');
    expect(mock).not.toHaveBeenCalled();
  });

  it('surfaces a friendly action error on 403', async () => {
    __resetStateForTests({ phase: 'ready', rows: [makeInstall({ id: 'inst_403' })] });
    setFetchSequence([{ status: 403, body: { error: 'forbidden' } }]);
    await handlePause('inst_403');
    const s = __getStateForTests();
    expect(s.actionError).toMatch(/Dev gate/);
    expect(s.actionInFlight).toBeNull();
  });
});

describe('uninstall two-step confirm', () => {
  it('first click arms the confirm window without fetching', async () => {
    __resetStateForTests({ phase: 'ready', rows: [makeInstall({ id: 'inst_u' })] });
    const mock = vi.fn();
    globalThis.fetch = mock as unknown as typeof fetch;
    await handleUninstall('inst_u');
    expect(mock).not.toHaveBeenCalled();
    const s = __getStateForTests();
    expect(s.pendingUninstallId).toBe('inst_u');
    expect(s.pendingUninstallExpiresAt).toBeGreaterThan(Date.now());
  });

  it('second click within window POSTs /uninstall and refetches', async () => {
    __resetStateForTests({
      phase: 'ready',
      rows: [makeInstall({ id: 'inst_u2' })],
      pendingUninstallId: 'inst_u2',
      pendingUninstallExpiresAt: Date.now() + 4_000,
    });
    const mock = setFetchSequence([
      { status: 200, body: { ok: true } },
      { status: 200, body: { installs: [] } },
      { status: 200, body: { skills: [] } },
    ]);
    await handleUninstall('inst_u2');
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls[0]![0]).toBe('/api/skills/installs/inst_u2/uninstall');
    expect(__getStateForTests().pendingUninstallId).toBeNull();
    expect(__getStateForTests().rows).toEqual([]);
  });

  it('verifies linked recurring schedule is paused after monetized uninstall', async () => {
    __resetStateForTests({
      phase: 'ready',
      rows: [makeInstall({ id: 'inst_u4', monetizationScheduleId: 'recurring_abc' })],
      pendingUninstallId: 'inst_u4',
      pendingUninstallExpiresAt: Date.now() + 4_000,
    });
    const mock = setFetchSequence([
      { status: 200, body: { ok: true } },
      { status: 200, body: { schedules: [{ id: 'recurring_abc', status: 'paused' }] } },
      { status: 200, body: { installs: [], installRows: [] } },
      { status: 200, body: { skills: [] } },
    ]);
    await handleUninstall('inst_u4');
    expect(mock).toHaveBeenCalledTimes(4);
    expect(mock.mock.calls[0]![0]).toBe('/api/skills/installs/inst_u4/uninstall');
    expect(mock.mock.calls[1]![0]).toBe('/api/recurring');
    expect(__getStateForTests().actionError).toBe('');
  });

  it('keeps uninstall result but surfaces action error when linked recurring schedule is not paused', async () => {
    __resetStateForTests({
      phase: 'ready',
      rows: [makeInstall({ id: 'inst_u5', monetizationScheduleId: 'recurring_active' })],
      pendingUninstallId: 'inst_u5',
      pendingUninstallExpiresAt: Date.now() + 4_000,
    });
    setFetchSequence([
      { status: 200, body: { ok: true } },
      { status: 200, body: { schedules: [{ id: 'recurring_active', status: 'active' }] } },
      { status: 200, body: { installs: [], installRows: [] } },
      { status: 200, body: { skills: [] } },
    ]);
    await handleUninstall('inst_u5');
    const s = __getStateForTests();
    expect(s.rows).toEqual([]);
    expect(s.actionError).toMatch(/linked creator payment schedule is active/);
  });

  it('second click after expiry re-arms instead of submitting', async () => {
    __resetStateForTests({
      phase: 'ready',
      rows: [makeInstall({ id: 'inst_u3' })],
      pendingUninstallId: 'inst_u3',
      pendingUninstallExpiresAt: Date.now() - 1, // already expired
    });
    const mock = vi.fn();
    globalThis.fetch = mock as unknown as typeof fetch;
    await handleUninstall('inst_u3');
    expect(mock).not.toHaveBeenCalled();
    const s = __getStateForTests();
    expect(s.pendingUninstallId).toBe('inst_u3');
    expect(s.pendingUninstallExpiresAt).toBeGreaterThan(Date.now());
  });
});
