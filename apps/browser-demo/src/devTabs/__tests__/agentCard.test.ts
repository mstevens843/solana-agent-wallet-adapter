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
    expect(bodyHtml()).toContain('Fetching the live AgentCard');
    expect(bodyHtml()).not.toContain('dev-agent-card-json');
  });

  it('unavailable state has no "Agent 7" wording and offers a retry', () => {
    __resetTabStateForTests({ status: 'unavailable' });
    const html = bodyHtml();
    expect(html).not.toContain('Agent 7');
    expect(html).not.toContain('Agent 5');
    expect(html).toContain('data-dev-agent-card-retry');
    expect(html).toContain("didn't respond");
  });

  it('error state escapes the error message and offers a retry', () => {
    __resetTabStateForTests({ status: 'error', errorMessage: '<broken>' });
    const html = bodyHtml();
    expect(html).toContain('Could not fetch AgentCard');
    expect(html).toContain('&lt;broken&gt;');
    expect(html).toContain('data-dev-agent-card-retry');
  });

  it('loaded state renders the summary strip + JSON viewer when card has fields', () => {
    __resetTabStateForTests({
      status: 'loaded',
      cardJson: {
        walletAddress: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
        supportedProtocols: ['ap2', 'acp'],
        version: 'abc123',
        name: 'Test',
      },
      fetchedAt: Date.now(),
    });
    const html = bodyHtml();
    expect(html).toContain('dev-agent-card-summary');
    expect(html).toContain('7tQA…Yc8M');
    expect(html).toContain('ap2');
    expect(html).toContain('acp');
    expect(html).toContain('abc123');
    expect(html).toContain('dev-agent-card-json');
  });

  it('loaded state with empty {} renders the empty-response notice instead of JSON', () => {
    __resetTabStateForTests({ status: 'loaded', cardJson: {}, fetchedAt: Date.now() });
    const html = bodyHtml();
    expect(html).toContain('response was empty');
    expect(html).not.toContain('dev-agent-card-json');
  });

  it('loaded state with null renders the empty-response notice', () => {
    __resetTabStateForTests({ status: 'loaded', cardJson: null, fetchedAt: Date.now() });
    expect(bodyHtml()).toContain('response was empty');
  });

  it('statusBadgeHtml branches by status', () => {
    __resetTabStateForTests({ status: 'idle' });
    expect(statusBadgeHtml()).toBe('');
    __resetTabStateForTests({ status: 'loading' });
    expect(statusBadgeHtml()).toContain('Fetching');
    __resetTabStateForTests({ status: 'loaded', cardJson: { walletAddress: 'X' }, fetchedAt: Date.now() });
    expect(statusBadgeHtml()).toContain('Loaded');
    __resetTabStateForTests({ status: 'loaded', cardJson: {}, fetchedAt: Date.now() });
    expect(statusBadgeHtml()).toContain('Empty response');
    __resetTabStateForTests({ status: 'unavailable' });
    expect(statusBadgeHtml()).toContain('unreachable');
    __resetTabStateForTests({ status: 'error', errorMessage: 'X' });
    expect(statusBadgeHtml()).toContain('failed');
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
  });

  it('panelHtml always renders the Copy public URL + View live + Refresh action row', () => {
    __resetTabStateForTests();
    const html = panelHtml();
    expect(html).toContain('data-copy-id="dev-agent-card-public-url"');
    expect(html).toContain('View live');
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
    expect(bodyHtml()).toContain('response was empty');
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
