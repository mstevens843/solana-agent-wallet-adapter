import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

// Tests run without Vite's env-var injection (VITE_AGENTIC_DEV_AP2_ACP=1,
// VITE_AGENTIC_DEV_WALLET_ALLOWLIST=…). Mock the gate so the state machine
// can be exercised end-to-end; the gate logic itself is exercised in
// devGate-specific tests.
vi.mock('../../devGate.js', () => ({
  DEV_LAYER1_ENABLED: true,
  DEV_WALLET_ALLOWLIST: Object.freeze(['4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd']),
  isDevWallet: (addr?: string | null) => addr === '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
}));

import { __resetConnectionStateForTests } from '../../connectionState.js';

beforeAll(() => {
  if (!(globalThis as { __DEV_TAB_REGISTRY_INSTALLED__?: boolean }).__DEV_TAB_REGISTRY_INSTALLED__) {
    (globalThis as { __DEV_TAB_REGISTRY_INSTALLED__?: boolean }).__DEV_TAB_REGISTRY_INSTALLED__ = true;
  }
});

import {
  __externalAgentsForTests,
  TERMINAL_STATUSES,
  bodyHtml,
  escapeHtml,
  fetchInbound,
  formatRelative,
  rowHtml,
  shortAddress,
  sortInbound,
  type NormalizedApproval,
} from '../externalAgents.js';
import { __ap2VerifiedBadgeForTests } from '../../devBadges/ap2Verified.js';

function makeApproval(overrides: Partial<NormalizedApproval> = {}): NormalizedApproval {
  return {
    id: 'apr_abc',
    kind: 'transfer_spl',
    status: 'ready',
    summary: 'AP2 inbound: Acme requests 1 USDC to Alice',
    amount: '1',
    token: 'USDC',
    recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
    cluster: 'devnet',
    dueAt: '2026-05-14T12:00:00.000Z',
    createdAt: '2026-05-14T11:00:00.000Z',
    updatedAt: '2026-05-14T11:00:00.000Z',
    txid: null,
    txStatus: null,
    metadata: {
      ap2VerifiedAgent: {
        agentId: 'agent:acme.v1',
        agentLabel: 'Acme',
        publicKey: 'BAse58PublicKeyOfTheAgent000000000000000000',
      },
      ap2MandateId: 'mandate_001',
      ap2MandateType: 'payment_mandate',
      connectorId: 'ap2',
      connectorName: 'Google AP2',
    },
    params: {},
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('pure helpers', () => {
  it('escapeHtml escapes the five HTML entities', () => {
    expect(escapeHtml('<b>"hi" & \'bye\'</b>')).toBe('&lt;b&gt;&quot;hi&quot; &amp; &#39;bye&#39;&lt;/b&gt;');
  });

  it('escapeHtml leaves safe text alone', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
    expect(escapeHtml('')).toBe('');
  });

  it('shortAddress truncates only when above 12 chars', () => {
    expect(shortAddress('7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M')).toBe('7tQA…Yc8M');
    expect(shortAddress('shorter12345')).toBe('shorter12345');
    expect(shortAddress('')).toBe('');
  });

  it('formatRelative buckets minutes, hours, days', () => {
    const now = Date.parse('2026-05-14T12:00:00.000Z');
    expect(formatRelative('2026-05-14T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelative('2026-05-14T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatRelative('2026-05-14T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelative('2026-05-12T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('formatRelative handles invalid input and future timestamps', () => {
    expect(formatRelative('not-an-iso')).toBe('not-an-iso');
    expect(formatRelative('')).toBe('');
    const now = Date.parse('2026-05-14T12:00:00.000Z');
    expect(formatRelative('2026-05-14T13:00:00.000Z', now)).toBe('in the future');
  });
});

describe('sortInbound', () => {
  it('places non-terminal rows before terminal rows', () => {
    const rows: NormalizedApproval[] = [
      makeApproval({ id: '1', status: 'approved', createdAt: '2026-05-14T01:00:00.000Z' }),
      makeApproval({ id: '2', status: 'ready', createdAt: '2026-05-14T02:00:00.000Z' }),
      makeApproval({ id: '3', status: 'cancelled', createdAt: '2026-05-14T03:00:00.000Z' }),
      makeApproval({ id: '4', status: 'pending', createdAt: '2026-05-14T00:30:00.000Z' }),
    ];
    const ordered = sortInbound(rows).map((r) => r.id);
    expect(ordered.indexOf('2')).toBeLessThan(ordered.indexOf('1'));
    expect(ordered.indexOf('2')).toBeLessThan(ordered.indexOf('3'));
    expect(ordered.indexOf('4')).toBeLessThan(ordered.indexOf('1'));
    expect(ordered).toEqual(['2', '4', '3', '1']);
  });

  it('does not mutate the original array', () => {
    const rows: NormalizedApproval[] = [
      makeApproval({ id: 'a', status: 'approved', createdAt: '2026-05-14T00:00:00.000Z' }),
      makeApproval({ id: 'b', status: 'ready', createdAt: '2026-05-14T01:00:00.000Z' }),
    ];
    const snapshot = rows.map((r) => r.id);
    sortInbound(rows);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });

  it('lists every terminal status in TERMINAL_STATUSES', () => {
    for (const status of ['approved', 'denied', 'cancelled', 'expired', 'rejected']) {
      expect(TERMINAL_STATUSES.has(status)).toBe(true);
    }
    expect(TERMINAL_STATUSES.has('ready')).toBe(false);
    expect(TERMINAL_STATUSES.has('pending')).toBe(false);
  });
});

describe('rowHtml', () => {
  it('shows the agent label, status pill, amount, recipient short form, kind, cluster', () => {
    const html = rowHtml(makeApproval());
    expect(html).toContain('>Acme</strong>');
    expect(html).toContain('status-pill pending');
    expect(html).toContain('>ready<');
    expect(html).toContain('1 USDC');
    expect(html).toContain('to 7tQA…Yc8M');
    expect(html).toContain('>transfer spl<');
    expect(html).toContain('>devnet<');
    expect(html).toContain('data-tab="inbox"');
    expect(html).toContain('data-external-agents-open="apr_abc"');
    expect(html).toContain('Open approval');
  });

  it('falls back to agentId when label missing, and to "unknown agent" when both missing', () => {
    const noLabel = rowHtml(
      makeApproval({
        metadata: {
          ap2VerifiedAgent: { agentId: 'agent:fallback', agentLabel: '' },
        },
      } as Partial<NormalizedApproval>),
    );
    expect(noLabel).toContain('agent:fallback');

    const noAgent = rowHtml(makeApproval({ metadata: {} }));
    expect(noAgent).toContain('unknown agent');
  });

  it('marks terminal rows with the .terminal class and "Open in Inbox" label', () => {
    const html = rowHtml(makeApproval({ status: 'approved' }));
    expect(html).toContain('class="external-agents-row terminal"');
    expect(html).toContain('Open in Inbox');
    expect(html).toContain('status-pill approved');
  });

  it('renders em-dash when amount is missing', () => {
    const html = rowHtml(makeApproval({ amount: null, token: null }));
    expect(html).toContain('external-agents-row-amount">—');
  });

  it('escapes hostile labels', () => {
    const html = rowHtml(
      makeApproval({
        metadata: { ap2VerifiedAgent: { agentId: 'x', agentLabel: '<script>alert(1)</script>' } },
        summary: '"); attack();',
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;); attack();');
  });
});

describe('bodyHtml', () => {
  it('renders the loading placeholder for idle and loading states', () => {
    expect(bodyHtml({ status: 'idle', inbound: [], errorMessage: '', lastFetchedFor: null })).toContain(
      'Loading inbound mandates',
    );
    expect(bodyHtml({ status: 'loading', inbound: [], errorMessage: '', lastFetchedFor: null })).toContain(
      'Loading inbound mandates',
    );
  });

  it('renders the empty state when loaded with zero rows', () => {
    const html = bodyHtml({ status: 'loaded', inbound: [], errorMessage: '', lastFetchedFor: DEV_WALLET });
    expect(html).toContain('No inbound AP2 mandates yet');
    expect(html).toContain('<strong>Needs Approval</strong>');
  });

  it('renders the list when loaded with rows', () => {
    const html = bodyHtml({
      status: 'loaded',
      inbound: [makeApproval()],
      errorMessage: '',
      lastFetchedFor: DEV_WALLET,
    });
    expect(html).toContain('<ol class="external-agents-list">');
    expect(html).toContain('>Acme</strong>');
  });

  it('renders the error state with a Retry button', () => {
    const html = bodyHtml({
      status: 'error',
      inbound: [],
      errorMessage: 'HTTP 500',
      lastFetchedFor: DEV_WALLET,
    });
    expect(html).toContain('Could not load inbound AP2 mandates: HTTP 500');
    expect(html).toContain('data-external-agents-retry');
  });
});

describe('fetchInbound state machine', () => {
  type FetchMock = ReturnType<typeof vi.fn>;
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    __resetConnectionStateForTests(DEV_WALLET);
    __externalAgentsForTests.resetState();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    __resetConnectionStateForTests(null);
    __externalAgentsForTests.resetState();
  });

  function defaultSessionResponse(): Response {
    return jsonResponse(200, { signedIn: true, session: { walletAddress: DEV_WALLET } });
  }

  it('loads mandates and transitions idle → loading → loaded on 200', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/session') return defaultSessionResponse();
      if (url === '/api/ap2/inbound') return jsonResponse(200, { inbound: [makeApproval()] });
      throw new Error(`unexpected url: ${url}`);
    });
    await fetchInbound();
    const after = __externalAgentsForTests.getState();
    expect(after.status).toBe('loaded');
    expect(after.inbound).toHaveLength(1);
    expect(after.inbound[0]!.id).toBe('apr_abc');
    expect(after.errorMessage).toBe('');
    expect(after.lastFetchedFor).toBe(DEV_WALLET);
  });

  it('treats 404 as empty list (deploy without AP2 routes)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/session') return defaultSessionResponse();
      if (url === '/api/ap2/inbound') return new Response('', { status: 404 });
      throw new Error(`unexpected url: ${url}`);
    });
    await fetchInbound();
    const after = __externalAgentsForTests.getState();
    expect(after.status).toBe('loaded');
    expect(after.inbound).toEqual([]);
  });

  it('transitions to error with friendly copy on 403', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/session') return defaultSessionResponse();
      if (url === '/api/ap2/inbound') return jsonResponse(403, { error: 'dev_layer1_disabled' });
      throw new Error(`unexpected url: ${url}`);
    });
    await fetchInbound();
    const after = __externalAgentsForTests.getState();
    expect(after.status).toBe('error');
    expect(after.errorMessage).toMatch(/disabled for this wallet/);
  });

  it('transitions to error with sign-in copy on 401', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/session') return defaultSessionResponse();
      if (url === '/api/ap2/inbound') return new Response('', { status: 401 });
      throw new Error(`unexpected url: ${url}`);
    });
    await fetchInbound();
    expect(__externalAgentsForTests.getState().errorMessage).toMatch(/Sign into Agentic Cloud/);
  });

  it('captures the HTTP code on other failures', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/session') return defaultSessionResponse();
      if (url === '/api/ap2/inbound') return new Response('', { status: 500 });
      throw new Error(`unexpected url: ${url}`);
    });
    await fetchInbound();
    expect(__externalAgentsForTests.getState().errorMessage).toBe('HTTP 500');
  });

  it('surfaces a thrown network error', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/session') return defaultSessionResponse();
      if (url === '/api/ap2/inbound') throw new Error('offline');
      throw new Error(`unexpected url: ${url}`);
    });
    await fetchInbound();
    const after = __externalAgentsForTests.getState();
    expect(after.status).toBe('error');
    expect(after.errorMessage).toBe('offline');
  });

  it('is a no-op when no wallet is set', async () => {
    __resetConnectionStateForTests(null);
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/session' ? jsonResponse(200, { signedIn: false }) : jsonResponse(200, { inbound: [] }),
    );
    await fetchInbound();
    const after = __externalAgentsForTests.getState();
    expect(after.status).toBe('idle');
    // /api/ap2/inbound should NOT have been called
    const ap2Calls = fetchMock.mock.calls.filter(([url]) => url === '/api/ap2/inbound');
    expect(ap2Calls).toHaveLength(0);
  });

  it('ignores re-entrant calls while a fetch is in flight (force=false)', async () => {
    const pending: { resolve: (value: Response) => void } = {
      resolve: () => {
        /* assigned in mockImplementation */
      },
    };
    let resolverReady = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/session') return defaultSessionResponse();
      if (url === '/api/ap2/inbound') {
        return new Promise<Response>((resolve) => {
          pending.resolve = resolve;
          resolverReady = true;
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const first = fetchInbound();
    const second = fetchInbound();
    // The re-entrancy guard fires synchronously: the second call sees
    // state.status==='loading' set by the first call before any await.
    expect(__externalAgentsForTests.getState().status).toBe('loading');
    // Wait for the first call to reach `await fetch('/api/ap2/inbound')`
    // and register its resolver before unblocking it.
    await vi.waitFor(() => {
      expect(resolverReady).toBe(true);
    });
    pending.resolve(jsonResponse(200, { inbound: [] }));
    await Promise.all([first, second]);
    const ap2Calls = fetchMock.mock.calls.filter(([url]) => url === '/api/ap2/inbound');
    expect(ap2Calls).toHaveLength(1);
    expect(__externalAgentsForTests.getState().status).toBe('loaded');
  });
});

describe('AP2 verified badge', () => {
  it('matches a well-formed verified-agent block', () => {
    expect(
      __ap2VerifiedBadgeForTests.matchAction({
        metadata: { ap2VerifiedAgent: { agentId: 'a', agentLabel: 'b' } },
      }),
    ).toBe(true);
    expect(
      __ap2VerifiedBadgeForTests.matchAction({
        metadata: { ap2VerifiedAgent: { agentId: 'a', agentLabel: 'b', publicKey: 'p' } },
      }),
    ).toBe(true);
  });

  it('rejects malformed or missing verified-agent metadata', () => {
    expect(__ap2VerifiedBadgeForTests.matchAction({})).toBe(false);
    expect(__ap2VerifiedBadgeForTests.matchAction({ metadata: null })).toBe(false);
    expect(__ap2VerifiedBadgeForTests.matchAction({ metadata: {} })).toBe(false);
    expect(__ap2VerifiedBadgeForTests.matchAction({ metadata: { ap2VerifiedAgent: undefined } })).toBe(false);
    expect(
      __ap2VerifiedBadgeForTests.matchAction({
        metadata: { ap2VerifiedAgent: { agentId: 'a' } as unknown as never },
      }),
    ).toBe(false);
    expect(
      __ap2VerifiedBadgeForTests.matchAction({
        metadata: { ap2VerifiedAgent: { agentLabel: 'b' } as unknown as never },
      }),
    ).toBe(false);
  });

  it('isValidVerifiedAgent narrows the type', () => {
    const candidate: unknown = { agentId: 'a', agentLabel: 'b' };
    expect(__ap2VerifiedBadgeForTests.isValidVerifiedAgent(candidate)).toBe(true);
  });
});
