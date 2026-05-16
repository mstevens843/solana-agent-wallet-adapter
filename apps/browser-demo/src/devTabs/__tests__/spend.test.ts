import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpendEnvelope } from '@solana-agent-wallet-adapter/workflow';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

vi.mock('../../devGate.js', () => ({
  isDevWallet: (addr?: string | null) => addr === DEV_WALLET,
}));

vi.mock('../../connectionState.js', () => ({
  currentAddress: () => DEV_WALLET,
  refreshConnection: async () => undefined,
}));

import { findDevTab } from '../../devTabRegistry.js';
import { __spendForTests } from '../spend.js';

function envelopes(): SpendEnvelope[] {
  return [
    {
      kind: 'one-time',
      action: {
        id: 'approval_mpp',
        walletAddress: DEV_WALLET,
        kind: 'transfer_spl',
        status: 'ready',
        summary: 'Agent requested 2 USDC via MPP.',
        params: {},
        dueAt: '2026-05-16T18:00:00.000Z',
        createdAt: '2026-05-16T17:00:00.000Z',
        updatedAt: '2026-05-16T17:00:00.000Z',
        amount: '2',
        token: 'USDC',
        recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
        metadata: { connectorId: 'mpp' },
      },
    },
    {
      kind: 'recurring',
      schedule: {
        id: 'recurring_active',
        status: 'active',
        walletAddress: DEV_WALLET,
        cluster: 'devnet',
        token: 'SOL',
        recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
        amount: '0.1',
        cadence: 'interval_days',
        createdAt: '2026-05-15T17:00:00.000Z',
        updatedAt: '2026-05-15T17:00:00.000Z',
        nextDueAt: '2026-05-17T17:00:00.000Z',
      },
    },
    {
      kind: 'streaming',
      session: {
        id: 'stream_live',
        walletAddress: DEV_WALLET,
        cluster: 'devnet',
        tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        delegatePubkey: 'delegate',
        ephemeralSignerPubkey: 'delegate',
        capAmount: '10',
        spentAmount: '3.25',
        expiresAt: '2026-05-16T19:00:00.000Z',
        status: 'active',
        createdAt: '2026-05-16T16:00:00.000Z',
        updatedAt: '2026-05-16T16:30:00.000Z',
        metadata: { tokenSymbol: 'USDC' },
      },
    },
  ];
}

describe('Spend dev tab', () => {
  beforeEach(() => {
    __spendForTests.resetState({
      status: 'loaded',
      envelopes: envelopes(),
      filter: 'all',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the Spend tab', () => {
    const tab = findDevTab('spend');
    expect(tab?.label).toBe('Spend');
    expect(tab?.guard()).toBe(true);
  });

  it('renders protocol and kind badges on unified rows', () => {
    const html = __spendForTests.spendRowHtml(envelopes()[0]!);
    expect(html).toContain('spend-badge--mpp');
    expect(html).toContain('>MPP<');
    expect(html).toContain('>One Time<');
    expect(html).toContain('spend-status--needs_approval');
  });

  it('filters schedules and streams without changing the source list', () => {
    const rows = envelopes();
    expect(__spendForTests.matchesFilter(rows[1]!, 'active_schedules')).toBe(true);
    expect(__spendForTests.matchesFilter(rows[0]!, 'active_schedules')).toBe(false);
    expect(__spendForTests.matchesFilter(rows[2]!, 'live_streams')).toBe(true);
  });

  it('renders summary counts and all three envelope kinds', () => {
    const html = __spendForTests.renderSpendPanel();
    expect(html).toContain('<h2>Spend</h2>');
    expect(html).toContain('Agent requested 2 USDC via MPP.');
    expect(html).toContain('0.1 SOL Interval Days');
    expect(html).toContain('3.25 of 10 USDC streamed');
  });

  it('keeps the collapsed row free of cross-tab buttons', () => {
    const html = __spendForTests.spendRowHtml(envelopes()[2]!);
    expect(html).toContain('data-spend-select="streaming:stream_live"');
    expect(html).not.toContain('data-tab="sessions"');
    expect(html).not.toContain('data-spend-legacy-tab="sessions"');
  });

  it('shows inline approval actions when a one-time envelope is selected', () => {
    __spendForTests.resetState({
      status: 'loaded',
      envelopes: envelopes(),
      selectedEnvelopeKey: 'one-time:approval_mpp',
    });

    const html = __spendForTests.spendRowHtml(envelopes()[0]!);
    expect(html).toContain('class="spend-row spend-row--one-time selected"');
    expect(html).toContain('data-spend-approval-op="execute"');
    expect(html).toContain('data-spend-approval-op="reject"');
    expect(html).not.toContain('data-tab="inbox"');
  });

  it('renders deep links into the legacy tabs for cross-navigation', () => {
    __spendForTests.resetState({
      status: 'loaded',
      envelopes: envelopes(),
      selectedEnvelopeKey: 'streaming:stream_live',
    });

    const html = __spendForTests.spendRowHtml(envelopes()[2]!);
    expect(html).toContain('data-spend-legacy-tab="sessions"');
    expect(html).toContain('data-spend-open="stream_live"');
  });

  it('loads server-filtered pages with counts and cursors', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({
        envelopes: [envelopes()[1]],
        counts: {
          all: 3,
          needs_approval: 1,
          active_schedules: 1,
          live_streams: 1,
          settled: 0,
        },
        pagination: { nextCursor: '50' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    __spendForTests.resetState({
      status: 'loaded',
      envelopes: [],
      filter: 'active_schedules',
    });

    await __spendForTests.loadSpendEnvelopes(true);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('filter=active_schedules');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=50');
    expect(__spendForTests.getState().counts?.all).toBe(3);
    expect(__spendForTests.getState().nextCursor).toBe('50');
    expect(__spendForTests.getState().loadedFilter).toBe('active_schedules');
  });
});
