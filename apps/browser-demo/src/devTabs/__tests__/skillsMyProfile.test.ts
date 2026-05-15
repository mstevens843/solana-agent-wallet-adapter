import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __fetchWalletStatsForTests,
  __getKickoffScheduledForTests,
  __getPanelStateForTests,
  __resetPanelStateForTests,
  buildPublicProfileUrl,
  escapeHtml,
  formatRelativeTime,
  formatSuccessRate,
  formatUsd,
  normalizeWalletStats,
  renderMyProfilePanel,
  shortAddress,
  type WalletStatsSnapshot,
} from '../skills/myProfile.js';
import {
  findSkillsSubTab,
  listSkillsSubTabs,
} from '../skills/subTabRegistry.js';
import { setConnectedAddress } from '../../walletState.js';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const SECOND_WALLET = '11111111111111111111111111111111';

function makeSnapshot(overrides: Partial<WalletStatsSnapshot> = {}): WalletStatsSnapshot {
  return {
    walletAddress: DEV_WALLET,
    totalSkillsInstalled: 3,
    totalExecutions: 12,
    successRate: 0.92,
    totalProfitUsd: '184.55',
    totalGasUsd: '6.20',
    installedSkillIds: ['friday-dca', 'yield-auto-rotate', 'bridge-idle-usdc'],
    computedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
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
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<b>"hi" & \'bye\'</b>')).toBe(
      '&lt;b&gt;&quot;hi&quot; &amp; &#39;bye&#39;&lt;/b&gt;',
    );
  });

  it('shortAddress shortens long inputs and leaves short ones alone', () => {
    expect(shortAddress(DEV_WALLET)).toBe('4fTq…MoHd');
    expect(shortAddress('short')).toBe('short');
    expect(shortAddress('')).toBe('');
  });

  it('buildPublicProfileUrl returns the canonical agentic-signer.com URL', () => {
    expect(buildPublicProfileUrl(DEV_WALLET)).toBe(
      `https://agentic-signer.com/u/${DEV_WALLET}`,
    );
  });

  it('formatSuccessRate clamps and rounds to percent', () => {
    expect(formatSuccessRate(0.94)).toBe('94%');
    expect(formatSuccessRate(1)).toBe('100%');
    expect(formatSuccessRate(0)).toBe('0%');
    expect(formatSuccessRate(1.2)).toBe('100%');
    expect(formatSuccessRate(-0.1)).toBe('0%');
    expect(formatSuccessRate(Number.NaN)).toBe('—');
  });

  it('formatUsd renders numeric strings and returns em-dash for missing values', () => {
    expect(formatUsd('1234.5')).toBe('$1,234.50');
    expect(formatUsd('0')).toBe('$0.00');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd('')).toBe('—');
    expect(formatUsd('not-a-number')).toBe('—');
  });

  it('formatRelativeTime returns human deltas with a stable reference now', () => {
    const now = Date.parse('2026-05-14T12:00:00.000Z');
    expect(formatRelativeTime('2026-05-14T11:59:30.000Z', now)).toBe('30s ago');
    expect(formatRelativeTime('2026-05-14T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatRelativeTime('2026-05-14T10:00:00.000Z', now)).toBe('2h ago');
    expect(formatRelativeTime('2026-05-13T12:00:00.000Z', now)).toBe('1d ago');
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });

  it('normalizeWalletStats accepts bare snapshots and aggregator envelopes', () => {
    const snapshot = makeSnapshot();
    expect(normalizeWalletStats(snapshot)).toEqual(snapshot);
    expect(normalizeWalletStats({ snapshot, kind: 'wallet', key: `wallet:${DEV_WALLET}` })).toEqual(snapshot);
    expect(normalizeWalletStats({ snapshot: { walletAddress: DEV_WALLET } })).toBeNull();
  });
});

describe('renderMyProfilePanel', () => {
  it('wraps every render in the panel root element', () => {
    expect(renderMyProfilePanel()).toContain('data-skills-profile-root');
  });

  it('noWallet phase prompts for connection and omits the Copy URL button', () => {
    __resetPanelStateForTests({ phase: 'noWallet' });
    const html = renderMyProfilePanel();
    expect(html).toContain('Connect the dev wallet');
    expect(html).not.toContain('data-skills-profile-action="copy-url"');
  });

  it('loading phase shows a busy skeleton', () => {
    __resetPanelStateForTests({ phase: 'loading' });
    const html = renderMyProfilePanel();
    expect(html).toContain('skills-profile-skeleton');
    expect(html).toContain('aria-busy="true"');
  });

  it('forbidden phase references the dev allowlist', () => {
    __resetPanelStateForTests({ phase: 'forbidden' });
    const html = renderMyProfilePanel();
    expect(html).toContain('dev allowlist');
    expect(html).not.toContain('data-skills-profile-action="copy-url"');
  });

  it('notDeployed phase still renders the Copy URL row so the URL pattern is visible', () => {
    __resetPanelStateForTests({ phase: 'notDeployed', wallet: DEV_WALLET });
    const html = renderMyProfilePanel();
    expect(html).toContain("hasn't deployed yet");
    expect(html).toContain('data-skills-profile-action="copy-url"');
    expect(html).toContain(buildPublicProfileUrl(DEV_WALLET));
  });

  it('error phase shows the supplied message and a retry trigger', () => {
    __resetPanelStateForTests({ phase: 'error', errorMessage: 'boom!', wallet: DEV_WALLET });
    const html = renderMyProfilePanel();
    expect(html).toContain('boom!');
    expect(html).toContain('data-skills-profile-action="retry"');
  });

  it('empty phase renders the zero-state and Copy URL row', () => {
    __resetPanelStateForTests({ phase: 'empty', wallet: DEV_WALLET });
    const html = renderMyProfilePanel();
    expect(html).toContain('No executions yet');
    expect(html).toContain('data-skills-profile-action="copy-url"');
  });

  it('loaded phase renders stats, chips, and the canonical public URL', () => {
    const snapshot = makeSnapshot();
    __resetPanelStateForTests({ phase: 'loaded', wallet: DEV_WALLET, snapshot });
    const html = renderMyProfilePanel();
    expect(html).toContain('92%');
    expect(html).toContain('$184.55');
    expect(html).toContain('$6.20');
    for (const id of snapshot.installedSkillIds) {
      expect(html).toContain(id);
    }
    expect(html).toContain('4fTq…MoHd');
    expect(html).toContain(buildPublicProfileUrl(DEV_WALLET));
    expect(html).toContain('data-skills-profile-action="copy-url"');
    expect(html).toContain('data-skills-profile-action="view-live"');
    expect(html).toContain('data-skills-profile-action="refresh"');
  });

  it('loaded phase HTML-escapes wallet-derived URL content', () => {
    __resetPanelStateForTests({
      phase: 'loaded',
      wallet: DEV_WALLET,
      snapshot: makeSnapshot(),
    });
    const html = renderMyProfilePanel();
    // The URL contains no special characters here, but ensure we did not
    // accidentally interpolate `data-skills-profile-value` unescaped (would
    // break attribute quoting if a wallet contained '"').
    expect(html).toMatch(/data-skills-profile-value="https:\/\/agentic-signer\.com\/u\/[A-Za-z0-9]+"/);
  });
});

describe('__resetPanelStateForTests', () => {
  it('resets phase, snapshot, errorMessage, and kickoffScheduled', () => {
    __resetPanelStateForTests({
      phase: 'loaded',
      wallet: DEV_WALLET,
      snapshot: makeSnapshot(),
      errorMessage: 'stale',
      fetchedAt: 42,
    });
    __resetPanelStateForTests();
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('idle');
    expect(state.wallet).toBeUndefined();
    expect(state.snapshot).toBeNull();
    expect(state.errorMessage).toBe('');
    expect(state.fetchedAt).toBe(0);
    expect(__getKickoffScheduledForTests()).toBe(false);
  });
});

describe('fetchWalletStats', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  it('maps a 200 snapshot with executions to phase=loaded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeSnapshot()));
    await __fetchWalletStatsForTests(DEV_WALLET);
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('loaded');
    expect(state.snapshot?.totalExecutions).toBe(12);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/aggregator/wallets/${DEV_WALLET}`);
  });

  it('maps a 200 aggregator envelope with executions to phase=loaded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      snapshot: makeSnapshot(),
      kind: 'wallet',
      key: `wallet:${DEV_WALLET}`,
      computedAt: '2026-05-14T12:00:00.000Z',
    }));
    await __fetchWalletStatsForTests(DEV_WALLET);
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('loaded');
    expect(state.snapshot?.walletAddress).toBe(DEV_WALLET);
  });

  it('maps malformed 200 responses to phase=error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { snapshot: { walletAddress: DEV_WALLET } }));
    await __fetchWalletStatsForTests(DEV_WALLET);
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toContain('Malformed wallet stats response');
  });

  it('maps an all-zero snapshot to phase=empty', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        makeSnapshot({
          totalExecutions: 0,
          totalSkillsInstalled: 0,
          installedSkillIds: [],
          totalProfitUsd: undefined,
          totalGasUsd: undefined,
        }),
      ),
    );
    await __fetchWalletStatsForTests(DEV_WALLET);
    expect(__getPanelStateForTests().phase).toBe('empty');
  });

  it('maps 403 to phase=forbidden', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'dev_layer1_disabled' }));
    await __fetchWalletStatsForTests(DEV_WALLET);
    expect(__getPanelStateForTests().phase).toBe('forbidden');
  });

  it('maps 404 to phase=notDeployed', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await __fetchWalletStatsForTests(DEV_WALLET);
    expect(__getPanelStateForTests().phase).toBe('notDeployed');
  });

  it('maps 500 to phase=error and surfaces the server message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'internal_error' }));
    await __fetchWalletStatsForTests(DEV_WALLET);
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toContain('internal_error');
  });

  it('drops stale resolutions when the wallet changes mid-flight', async () => {
    let resolveFirst: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeSnapshot({ walletAddress: 'second-wallet' })));
    const firstPromise = __fetchWalletStatsForTests(DEV_WALLET);
    const secondPromise = __fetchWalletStatsForTests('second-wallet');
    resolveFirst!(jsonResponse(200, makeSnapshot()));
    await Promise.all([firstPromise, secondPromise]);
    expect(__getPanelStateForTests().wallet).toBe('second-wallet');
    // The second wallet's snapshot wins.
    expect(__getPanelStateForTests().snapshot?.walletAddress).toBe('second-wallet');
  });
});

describe('registry render closure', () => {
  it('registers the My Profile sub-tab on module load', () => {
    const ids = listSkillsSubTabs().map((tab) => tab.id);
    expect(ids).toContain('profile');
  });

  it('renders noWallet body when nothing is connected', () => {
    setConnectedAddress(undefined);
    const tab = findSkillsSubTab('profile');
    expect(tab).toBeDefined();
    const html = tab!.render();
    expect(html).toContain('Connect the dev wallet');
  });

  it('queues a single fetch when the panel mounts twice synchronously', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, makeSnapshot()));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    setConnectedAddress(DEV_WALLET);
    const tab = findSkillsSubTab('profile')!;
    tab.render();
    tab.render();
    expect(__getKickoffScheduledForTests()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queues a fetch when the wallet connects after a no-wallet render', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, makeSnapshot()));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const tab = findSkillsSubTab('profile')!;
    setConnectedAddress(undefined);
    expect(tab.render()).toContain('Connect the dev wallet');
    setConnectedAddress(DEV_WALLET);
    tab.render();
    expect(__getKickoffScheduledForTests()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(__getPanelStateForTests().phase).toBe('loaded');
  });

  it('refetches and clears stale stats when the connected wallet changes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, makeSnapshot()))
      .mockResolvedValueOnce(jsonResponse(200, makeSnapshot({ walletAddress: SECOND_WALLET })));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const tab = findSkillsSubTab('profile')!;
    setConnectedAddress(DEV_WALLET);
    tab.render();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(__getPanelStateForTests().snapshot?.walletAddress).toBe(DEV_WALLET);

    setConnectedAddress(SECOND_WALLET);
    tab.render();
    expect(__getPanelStateForTests().snapshot).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(__getPanelStateForTests().snapshot?.walletAddress).toBe(SECOND_WALLET);
  });
});
