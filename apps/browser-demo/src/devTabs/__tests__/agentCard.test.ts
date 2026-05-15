import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirror the payOut.test.ts setup. The agentCard module's CSS import is
// gated on `typeof document !== 'undefined'`, and so is the body-level
// click delegate, so leaving `document` unset prevents Vite style
// injection while still letting us exercise the pure helpers + the
// fetchAgentCard state machine.

beforeAll(() => {
  if (!(globalThis as { __DEV_TAB_REGISTRY_INSTALLED__?: boolean }).__DEV_TAB_REGISTRY_INSTALLED__) {
    (globalThis as { __DEV_TAB_REGISTRY_INSTALLED__?: boolean }).__DEV_TAB_REGISTRY_INSTALLED__ = true;
  }
});

import {
  __getTabStateForTests,
  __resetTabStateForTests,
  bodyHtml,
  escapeHtml,
  fetchAgentCard,
  formatProtocols,
  formatTime,
  panelHtml,
  shortAddress,
  stableJson,
  statusBadgeHtml,
} from '../agentCard.js';

describe('pure helpers', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<b>"hi" & \'bye\'</b>')).toBe('&lt;b&gt;&quot;hi&quot; &amp; &#39;bye&#39;&lt;/b&gt;');
  });

  it('escapeHtml returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('stableJson pretty-prints objects with 2-space indent', () => {
    expect(stableJson({ a: 1, b: [2, 3] })).toContain('"a": 1');
    expect(stableJson({ a: 1, b: [2, 3] })).toContain('"b": [');
  });

  it('stableJson returns empty string for undefined', () => {
    expect(stableJson(undefined)).toBe('');
  });

  it('stableJson renders null as "null"', () => {
    expect(stableJson(null)).toBe('null');
  });

  it('formatTime returns HH:MM:SS-style local time for a timestamp', () => {
    const result = formatTime(Date.UTC(2026, 4, 14, 10, 30, 0));
    expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it('formatTime returns empty string for undefined', () => {
    expect(formatTime(undefined)).toBe('');
  });

  it('shortAddress truncates long base58 addresses', () => {
    expect(shortAddress('7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M')).toBe('7tQA…Yc8M');
  });

  it('shortAddress leaves short inputs untouched', () => {
    expect(shortAddress('short')).toBe('short');
    expect(shortAddress('')).toBe('');
    expect(shortAddress(undefined)).toBe('');
  });

  it('formatProtocols joins entries with a middle dot', () => {
    expect(formatProtocols(['ap2', 'acp'])).toBe('ap2 · acp');
  });

  it('formatProtocols returns em-dash for empty input', () => {
    expect(formatProtocols([])).toBe('—');
    expect(formatProtocols(undefined)).toBe('—');
    expect(formatProtocols(null)).toBe('—');
  });
});

describe('panelHtml + bodyHtml states', () => {
  beforeEach(() => {
    __resetTabStateForTests();
  });

  it('idle state renders the loading message and no JSON viewer', () => {
    expect(bodyHtml()).toContain('Checking this wallet&apos;s payment profile');
    expect(bodyHtml()).not.toContain('dev-agent-card-json');
  });

  it('unavailable state has no "Agent 7" wording and offers a retry', () => {
    __resetTabStateForTests({ status: 'unavailable' });
    const html = bodyHtml();
    expect(html).not.toContain('Agent 7');
    expect(html).not.toContain('Agent 5');
    expect(html).toContain('data-dev-agent-card-retry');
    expect(html).toContain('payment profile is not reachable');
  });

  it('error state escapes the error message and offers a retry', () => {
    __resetTabStateForTests({ status: 'error', errorMessage: '<broken>' });
    const html = bodyHtml();
    expect(html).toContain('Could not check payment profile');
    expect(html).toContain('&lt;broken&gt;');
    expect(html).toContain('data-dev-agent-card-retry');
  });

  it('loaded state renders a readable identity view with raw JSON in advanced details', () => {
    __resetTabStateForTests({
      status: 'loaded',
      cardJson: {
        walletAddress: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
        supportedProtocols: ['ap2', 'acp'],
        supportedTokens: ['USDC', 'SOL'],
        version: 'abc123',
        name: 'Test Agent',
        description: 'Signs only after user approval.',
        url: 'https://example.test',
        capabilities: {
          streaming: false,
          pushNotifications: true,
          stateTransitionHistory: false,
        },
        skills: [
          { id: 'wallet.sign_message', name: 'Sign Message', description: 'Sign a message.' },
          { id: 'wallet.pay_cart', name: 'Pay Cart', description: 'Review and approve a payment request.' },
        ],
      },
      fetchedAt: Date.now(),
    });
    const html = bodyHtml();
    expect(html).toContain('dev-agent-card-readable');
    expect(html).toContain('Active payment profile');
    expect(html).toContain('Test Agent');
    expect(html).toContain('Every request still opens for review');
    expect(html).toContain('dev-agent-card-summary');
    expect(html).toContain('7tQA…Yc8M');
    expect(html).toContain('ap2');
    expect(html).toContain('acp');
    expect(html).toContain('USDC');
    expect(html).toContain('SOL');
    expect(html).toContain('abc123');
    expect(html).toContain('How this profile is used');
    expect(html).toContain('Incoming payments');
    expect(html).toContain('Checkout payments');
    expect(html).toContain('Always review');
    expect(html).toContain('What other apps can ask for');
    expect(html).toContain('Sign Message');
    expect(html).toContain('Pay Cart');
    expect(html).toContain('https://example.test/.well-known/agent.json');
    expect(html).toContain('View technical profile JSON');
    expect(html).toContain('dev-agent-card-json');
  });

  it('loaded state with empty {} renders the empty-response notice instead of JSON', () => {
    __resetTabStateForTests({ status: 'loaded', cardJson: {}, fetchedAt: Date.now() });
    const html = bodyHtml();
    expect(html).toContain('does not have a payment profile');
    expect(html).not.toContain('dev-agent-card-json');
  });

  it('loaded state with null renders the empty-response notice', () => {
    __resetTabStateForTests({ status: 'loaded', cardJson: null, fetchedAt: Date.now() });
    expect(bodyHtml()).toContain('does not have a payment profile');
  });

  it('statusBadgeHtml branches by status', () => {
    __resetTabStateForTests({ status: 'idle' });
    expect(statusBadgeHtml()).toBe('');
    __resetTabStateForTests({ status: 'loading' });
    expect(statusBadgeHtml()).toContain('Checking');
    __resetTabStateForTests({ status: 'loaded', cardJson: { walletAddress: 'X' }, fetchedAt: Date.now() });
    expect(statusBadgeHtml()).toContain('Live');
    __resetTabStateForTests({ status: 'loaded', cardJson: {}, fetchedAt: Date.now() });
    expect(statusBadgeHtml()).toContain('Needs setup');
    __resetTabStateForTests({ status: 'unavailable' });
    expect(statusBadgeHtml()).toContain('Unavailable');
    __resetTabStateForTests({ status: 'error', errorMessage: 'X' });
    expect(statusBadgeHtml()).toContain('Check failed');
  });

  it('panelHtml shows Copy JSON only when a non-empty card is loaded', () => {
    __resetTabStateForTests({ status: 'idle' });
    expect(panelHtml()).not.toContain('data-copy-id="dev-agent-card-json"');
    __resetTabStateForTests({ status: 'loaded', cardJson: {}, fetchedAt: Date.now() });
    expect(panelHtml()).not.toContain('data-copy-id="dev-agent-card-json"');
    __resetTabStateForTests({
      status: 'loaded',
      cardJson: { name: 'AC', walletAddress: 'X' },
      fetchedAt: Date.now(),
    });
    expect(panelHtml()).toContain('data-copy-id="dev-agent-card-json"');
    expect(panelHtml()).toContain('Copy JSON');
  });

  it('panelHtml always renders the Copy profile link + Open profile + Refresh action row', () => {
    __resetTabStateForTests();
    const html = panelHtml();
    expect(html).toContain('data-copy-id="dev-agent-card-public-url"');
    expect(html).toContain('Copy profile link');
    expect(html).toContain('Open profile');
    expect(html).toContain('data-dev-agent-card-retry');
  });
});

describe('fetchAgentCard behavior', () => {
  type FetchMock = ReturnType<typeof vi.fn>;
  let fetchMock: FetchMock;

  beforeEach(() => {
    __resetTabStateForTests();
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  it('200 + valid JSON transitions to loaded with cardJson populated and fetchedAt set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'X', walletAddress: 'Y' }));
    await fetchAgentCard();
    const state = __getTabStateForTests();
    expect(state.status).toBe('loaded');
    expect(state.cardJson).toEqual({ name: 'X', walletAddress: 'Y' });
    expect(typeof state.fetchedAt).toBe('number');
  });

  it('404 transitions to unavailable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not_found' }));
    await fetchAgentCard();
    expect(__getTabStateForTests().status).toBe('unavailable');
  });

  it('500 transitions to error with HTTP status in errorMessage', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await fetchAgentCard();
    const state = __getTabStateForTests();
    expect(state.status).toBe('error');
    expect(state.errorMessage).toBe('HTTP 500');
  });

  it('thrown fetch transitions to error with the message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network is down'));
    await fetchAgentCard();
    const state = __getTabStateForTests();
    expect(state.status).toBe('error');
    expect(state.errorMessage).toBe('network is down');
  });

  it('200 + empty body keeps status loaded; the empty UI is rendered via bodyHtml', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await fetchAgentCard();
    const state = __getTabStateForTests();
    expect(state.status).toBe('loaded');
    expect(state.cardJson).toEqual({});
    expect(bodyHtml()).toContain('does not have a payment profile');
  });

  it('does not stack a second fetch while loading', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    fetchMock.mockReturnValueOnce(first);
    const inflight = fetchAgentCard();
    await fetchAgentCard();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFirst(jsonResponse(200, { name: 'X' }));
    await inflight;
  });
});
