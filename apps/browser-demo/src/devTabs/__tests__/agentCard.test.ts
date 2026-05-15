import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../connectionState.js', () => ({
  currentAddress: () => '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
  refreshConnection: () => Promise.resolve(),
}));

beforeAll(() => {
  const flagHolder = globalThis as { __DEV_TAB_REGISTRY_INSTALLED__?: boolean };
  if (!flagHolder.__DEV_TAB_REGISTRY_INSTALLED__) {
    flagHolder.__DEV_TAB_REGISTRY_INSTALLED__ = true;
  }
});

import {
  __getTabStateForTests,
  __resetTabStateForTests,
  escapeHtml,
  formatTime,
  panelHtml,
  shortAddress,
} from '../agentCard.js';
import {
  setCloudWalletBridge,
  type CloudWalletBridge,
} from '../../cloudWalletBridge.js';
import type { AgentPaymentProfilePayload } from '@solana-agent-wallet-adapter/a2a-agent-card';

interface MockRequestRecord {
  path: string;
  init?: RequestInit;
  body?: unknown;
}

function parseBody(init?: RequestInit): unknown {
  if (!init || typeof init.body !== 'string') return undefined;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

function publishedPayload(): AgentPaymentProfilePayload {
  return {
    version: 1,
    discoverable: true,
    displayName: 'Mathew Wallet',
    acceptedTokens: ['USDC', 'USDT', 'SOL'],
    protocols: ['ap2', 'acp', 'a2a'],
  };
}

describe('pure helpers', () => {
  it('escapeHtml escapes HTML special chars and tolerates empty input', () => {
    expect(escapeHtml('<b>"hi" & \'bye\'</b>')).toBe('&lt;b&gt;&quot;hi&quot; &amp; &#39;bye&#39;&lt;/b&gt;');
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('shortAddress shortens long addresses with an ellipsis and leaves short input intact', () => {
    expect(shortAddress('4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd')).toBe('4fTq…MoHd');
    expect(shortAddress('short')).toBe('short');
    expect(shortAddress(null)).toBe('');
  });

  it('formatTime returns an empty string when given no timestamp', () => {
    expect(formatTime(undefined)).toBe('');
    expect(formatTime(null)).toBe('');
  });
});

describe('panelHtml — header always renders', () => {
  beforeEach(() => {
    __resetTabStateForTests();
  });

  it('always renders the Payment Profile header and status card', () => {
    const html = panelHtml();
    expect(html).toContain('Payment Profile');
    expect(html).toContain('Approval required');
    expect(html).toContain('Profile status');
  });

  it('renders the empty-state body when status is idle', () => {
    expect(panelHtml()).toContain('Loading your payment profile');
  });
});

describe('panelHtml — loaded body sections', () => {
  beforeEach(() => {
    __resetTabStateForTests({
      status: 'loaded',
      fetched: { payload: publishedPayload(), updatedAt: '2026-05-15T00:00:00Z', version: 1 },
      draft: {
        discoverable: true,
        displayName: 'Mathew Wallet',
        acceptedTokens: new Set(['USDC', 'USDT', 'SOL']),
        protocols: new Set(['ap2', 'acp', 'a2a']),
        contactEmail: '',
      },
    });
  });

  it('renders the editable form with discoverable toggle, name field, token + protocol chips', () => {
    const html = panelHtml();
    expect(html).toContain('Edit your payment profile');
    expect(html).toContain('data-profile-toggle="discoverable"');
    expect(html).toContain('data-profile-field="displayName"');
    expect(html).toContain('data-profile-chip-token="USDC"');
    expect(html).toContain('data-profile-chip-protocol="ap2"');
    expect(html).toContain('AP2 Inbound');
    expect(html).toContain('ACP Checkout');
    expect(html).toContain('A2A Discovery');
  });

  it('shows the per-wallet link in the live state (not the demo URL)', () => {
    // jsdom defaults window.location.origin to http://localhost:3000
    const html = panelHtml();
    expect(html).toContain('/card.json');
    expect(html).not.toContain('agentic-signer.com/.well-known');
  });

  it('shows the cross-link demo trigger', () => {
    expect(panelHtml()).toContain('Try a sample agent payment');
  });

  it('renders the bottom collapsible "What\'s a payment profile?" explainer reusing the request-context primitive', () => {
    const html = panelHtml();
    expect(html).toContain('public-request-context');
    expect(html).toContain('dev-agent-card-explainer');
    expect(html).toContain("What's a payment profile?");
    expect(html).toContain('Without a profile');
    expect(html).toContain('With a profile');
    expect(html).toContain('When it matters');
    expect(html).toContain('When it doesn');
  });

  it('renders the Take profile down button when a record exists', () => {
    expect(panelHtml()).toContain('data-profile-action="takedown"');
  });

  it('hides the takedown button before any record has been saved', () => {
    __resetTabStateForTests({
      status: 'loaded',
      fetched: { payload: null, updatedAt: null, version: 0 },
      draft: {
        discoverable: false,
        displayName: 'Wallet 4fTq…MoHd',
        acceptedTokens: new Set(['USDC']),
        protocols: new Set(['ap2']),
        contactEmail: '',
      },
    });
    expect(panelHtml()).not.toContain('data-profile-action="takedown"');
  });
});

describe('panelHtml — disabled link in hidden state', () => {
  it('shows the per-wallet URL grayed with a help line when hidden', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { location: { origin: 'https://agentic-signer.com' } };
    try {
      __resetTabStateForTests({
        status: 'loaded',
        fetched: {
          payload: { ...publishedPayload(), discoverable: false },
          updatedAt: '2026-05-15T00:00:00Z',
          version: 2,
        },
        draft: {
          discoverable: false,
          displayName: 'Mathew Wallet',
          acceptedTokens: new Set(['USDC']),
          protocols: new Set(['ap2']),
          contactEmail: '',
        },
      });
      const html = panelHtml();
      expect(html).toContain('dev-agent-card-link-section--disabled');
      expect(html).toContain('Toggle Discoverable on');
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });
});

describe('save flow', () => {
  const calls: MockRequestRecord[] = [];
  let bridge: CloudWalletBridge;

  beforeEach(() => {
    calls.length = 0;
    bridge = {
      async signMessage(message, _summary) {
        return { signature: `sig_${message.length}`, encoding: 'base58' };
      },
      async cloudRequest<T>(path: string, init?: RequestInit): Promise<T> {
        const record: MockRequestRecord = { path, init, body: parseBody(init) };
        calls.push(record);
        if (path === '/api/agents/profile-intent') {
          return {
            nonce: 'nonce-123',
            message: 'sign this',
            domain: 'localhost',
            issuedAt: '2026-05-15T00:00:00Z',
            expiresAt: '2026-05-15T00:05:00Z',
            walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
            action: 'publish',
          } as unknown as T;
        }
        if (path === '/api/agents/profile') {
          return {
            ok: true,
            profile: {
              namespace: 'agent-payment-profile',
              payload: publishedPayload(),
              updatedAt: '2026-05-15T00:00:00Z',
              version: 1,
            },
          } as unknown as T;
        }
        throw new Error(`Unmocked path: ${path}`);
      },
    };
    setCloudWalletBridge(bridge);
    __resetTabStateForTests({
      status: 'loaded',
      fetched: { payload: null, updatedAt: null, version: 0 },
      draft: {
        discoverable: true,
        displayName: 'Mathew Wallet',
        acceptedTokens: new Set(['USDC', 'USDT', 'SOL']),
        protocols: new Set(['ap2', 'acp', 'a2a']),
        contactEmail: '',
      },
    });
  });

  afterEach(() => {
    // restore a no-op bridge so other tests don't leak
    setCloudWalletBridge({
      async signMessage() { throw new Error('bridge cleared'); },
      async cloudRequest() { throw new Error('bridge cleared'); },
    });
  });

  it('publishes a valid form via intent → sign → PUT and stores the returned profile', async () => {
    const mod = await import('../agentCard.js');
    // Internal save is wired through DOM events; we exercise it directly by
    // dispatching a click on the save button via a stub element.
    // Because the DOM may not be present in jsdom-less suites, call the
    // private save flow via re-exported handlers if available — otherwise
    // we drive it through the click delegate.
    if (typeof document === 'undefined') return;
    document.body.innerHTML = '<button data-profile-action="save"></button>';
    document.querySelector<HTMLButtonElement>('[data-profile-action="save"]')!.click();
    // Allow the async save flow to resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.path}`)).toEqual([
      'POST /api/agents/profile-intent',
      'PUT /api/agents/profile',
    ]);
    const state = __getTabStateForTests();
    expect(state.fetched?.payload?.discoverable).toBe(true);
    expect(state.formBanner?.tone).toBe('success');
    // Ensure mod is the same import the test driver used.
    expect(typeof mod.panelHtml).toBe('function');
  });

  it('rejects an invalid form without making any network calls', async () => {
    __resetTabStateForTests({
      status: 'loaded',
      fetched: { payload: null, updatedAt: null, version: 0 },
      draft: {
        discoverable: true,
        displayName: '',
        acceptedTokens: new Set([]),
        protocols: new Set([]),
        contactEmail: '',
      },
    });
    if (typeof document === 'undefined') return;
    document.body.innerHTML = '<button data-profile-action="save"></button>';
    document.querySelector<HTMLButtonElement>('[data-profile-action="save"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(0);
    const state = __getTabStateForTests();
    expect(state.fieldErrors.length).toBeGreaterThan(0);
    expect(state.formBanner?.tone).toBe('error');
  });
});

describe('takedown flow', () => {
  const calls: MockRequestRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
    setCloudWalletBridge({
      async signMessage(message) { return { signature: `sig_${message.length}`, encoding: 'base58' }; },
      async cloudRequest<T>(path: string, init?: RequestInit): Promise<T> {
        calls.push({ path, init, body: parseBody(init) });
        if (path === '/api/agents/profile-intent') {
          return {
            nonce: 'nonce-takedown',
            message: 'sign takedown',
            domain: 'localhost',
            issuedAt: '2026-05-15T00:00:00Z',
            expiresAt: '2026-05-15T00:05:00Z',
            walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
            action: 'takedown',
          } as unknown as T;
        }
        if (path === '/api/agents/profile') {
          return {
            ok: true,
            profile: {
              namespace: 'agent-payment-profile',
              payload: { ...publishedPayload(), discoverable: false },
              updatedAt: '2026-05-15T00:01:00Z',
              version: 2,
            },
          } as unknown as T;
        }
        throw new Error(`Unmocked path: ${path}`);
      },
    });
    __resetTabStateForTests({
      status: 'loaded',
      fetched: { payload: publishedPayload(), updatedAt: '2026-05-15T00:00:00Z', version: 1 },
      draft: {
        discoverable: true,
        displayName: 'Mathew Wallet',
        acceptedTokens: new Set(['USDC']),
        protocols: new Set(['ap2']),
        contactEmail: '',
      },
    });
  });

  afterEach(() => {
    setCloudWalletBridge({
      async signMessage() { throw new Error('bridge cleared'); },
      async cloudRequest() { throw new Error('bridge cleared'); },
    });
  });

  it('takes the profile down via intent → sign → DELETE and flips discoverable false', async () => {
    if (typeof document === 'undefined') return;
    document.body.innerHTML = '<button data-profile-action="takedown"></button>';
    document.querySelector<HTMLButtonElement>('[data-profile-action="takedown"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.path}`)).toEqual([
      'POST /api/agents/profile-intent',
      'DELETE /api/agents/profile',
    ]);
    expect(__getTabStateForTests().fetched?.payload?.discoverable).toBe(false);
  });
});

describe('try-demo cross-link', () => {
  beforeEach(() => {
    __resetTabStateForTests();
  });

  it('clicks the Incoming Requests sub-tab and the demo trigger when the demo button fires', async () => {
    if (typeof document === 'undefined') return;
    const clicked: string[] = [];
    document.body.innerHTML = `
      <button data-agent-protocols-subtab="external-agents"></button>
      <button data-external-agents-demo></button>
      <button data-profile-action="try-demo"></button>
    `;
    document.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.agentProtocolsSubtab) clicked.push('subtab');
        else if (btn.hasAttribute('data-external-agents-demo')) clicked.push('demo');
        else if (btn.dataset.profileAction === 'try-demo') clicked.push('try-demo');
      });
    });
    document.querySelector<HTMLButtonElement>('[data-profile-action="try-demo"]')!.click();
    // requestAnimationFrame deferred — flush via microtask + rAF
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(clicked).toContain('try-demo');
    expect(clicked).toContain('subtab');
    expect(clicked).toContain('demo');
  });
});
