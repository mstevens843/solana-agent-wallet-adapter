import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal stubs to let payOut.ts load in vitest's default node env. The CSS
// import is gated on `typeof document !== 'undefined'`, so leaving document
// unset prevents the Vite style-injection side effect, while letting us
// import the pure renderers and the fetch wrappers.

beforeAll(() => {
  // No DOM stubbing here — payOut.ts is structured to no-op DOM bits when
  // `document` is undefined. Tests that need a fake document install one
  // explicitly inside the test body.
  if (!(globalThis as { __DEV_TAB_REGISTRY_INSTALLED__?: boolean }).__DEV_TAB_REGISTRY_INSTALLED__) {
    (globalThis as { __DEV_TAB_REGISTRY_INSTALLED__?: boolean }).__DEV_TAB_REGISTRY_INSTALLED__ = true;
  }
});

import {
  SAMPLE_CART,
  __getPanelStateForTests,
  __resetPanelStateForTests,
  approveCart,
  escapeHtml,
  handleAction,
  normalizePreview,
  parseCartText,
  previewCart,
  renderPayOutPanel,
  shortAddress,
} from '../payOut.js';

describe('pure helpers', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<b>"hi" & \'bye\'</b>')).toBe('&lt;b&gt;&quot;hi&quot; &amp; &#39;bye&#39;&lt;/b&gt;');
  });

  it('shortens long addresses', () => {
    expect(shortAddress('7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M')).toBe('7tQA…Yc8M');
    expect(shortAddress('short')).toBe('short');
    expect(shortAddress('')).toBe('');
  });

  it('parseCartText returns parsed JSON', () => {
    expect(parseCartText('{"a":1}')).toEqual({ a: 1 });
  });

  it('parseCartText rejects empty input with a friendly message', () => {
    expect(() => parseCartText('   ')).toThrow(/Paste an ACP cart/);
  });

  it('parseCartText rejects malformed JSON', () => {
    expect(() => parseCartText('{not json}')).toThrow(/not valid JSON/);
  });
});

describe('normalizePreview', () => {
  it('accepts a well-formed payload and keeps known fields', () => {
    const result = normalizePreview({
      cartId: 'cart_001',
      merchant: { name: 'Acme', wallet: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M' },
      recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenSymbol: 'USDC',
      lineItems: [
        { label: 'Latte', quantity: 2, amount: '12.00' },
        { label: 'Tax', amount: '1.30' },
        { label: '', amount: 'oops' }, // dropped (empty label)
        'garbage', // dropped (wrong shape)
      ],
      total: '13.30',
      memo: 'demo',
    });
    expect(result.cartId).toBe('cart_001');
    expect(result.merchant.name).toBe('Acme');
    expect(result.lineItems).toHaveLength(2);
    expect(result.lineItems[0]).toEqual({ label: 'Latte', amount: '12.00', quantity: 2 });
    expect(result.lineItems[1]).toEqual({ label: 'Tax', amount: '1.30', quantity: undefined });
    expect(result.total).toBe('13.30');
    expect(result.memo).toBe('demo');
  });

  it('throws when required fields are missing', () => {
    expect(() => normalizePreview({ merchant: {}, lineItems: [], total: '1' })).toThrow();
    expect(() => normalizePreview(null)).toThrow();
  });
});

describe('renderPayOutPanel', () => {
  beforeEach(() => {
    __resetPanelStateForTests();
  });

  it('compose phase renders the textarea + preview button', () => {
    const html = renderPayOutPanel();
    expect(html).toContain('id="pay-out-cart-input"');
    expect(html).toContain('data-pay-out-action="preview"');
    expect(html).toContain('data-pay-out-action="load-sample"');
    expect(html).not.toContain('data-pay-out-preview');
  });

  it('preview phase renders one row per line item, total, and the confirm button', () => {
    __resetPanelStateForTests({
      phase: 'preview',
      cartText: SAMPLE_CART,
      preview: {
        cartId: 'cart_x',
        merchant: { name: 'Acme', wallet: 'WMERCH8aLg5jLA7Mw' },
        recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
        tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        tokenSymbol: 'USDC',
        lineItems: [
          { label: 'Latte', quantity: 2, amount: '12.00' },
          { label: 'Croissant', amount: '4.50' },
          { label: 'Tax', amount: '1.30' },
        ],
        total: '17.80',
      },
    });
    const html = renderPayOutPanel();
    expect(html).toContain('data-pay-out-preview');
    expect(html).toContain('Latte');
    expect(html).toContain('Croissant');
    expect(html).toContain('Tax');
    expect(html).toMatch(/× 2/);
    expect(html).toContain('17.80');
    expect(html).toContain('USDC');
    expect(html).toContain('7tQA…Yc8M');
    expect(html).toContain('data-pay-out-action="confirm"');
    expect(html).toContain('data-pay-out-action="edit"');
  });

  it('renders the dismissible error banner when set', () => {
    __resetPanelStateForTests({ error: 'Something broke' });
    const html = renderPayOutPanel();
    expect(html).toContain('Something broke');
    expect(html).toContain('data-pay-out-action="dismiss-error"');
  });

  it('renders the notice banner when set', () => {
    __resetPanelStateForTests({
      notice: { title: 'Backend offline', body: 'Try again later.' },
    });
    const html = renderPayOutPanel();
    expect(html).toContain('Backend offline');
    expect(html).toContain('data-pay-out-action="dismiss-notice"');
  });
});

describe('previewCart + approveCart fetch behavior', () => {
  type FetchMock = ReturnType<typeof vi.fn>;
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  function jsonResponse(status: number, body: unknown): Response {
    const text = JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
  }

  it('previewCart returns ok with normalized preview on 200', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        preview: {
          merchant: { name: 'Acme' },
          recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
          tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          tokenSymbol: 'USDC',
          lineItems: [{ label: 'Latte', amount: '12.00' }],
          total: '12.00',
        },
      }),
    );
    const result = await previewCart({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/acp/cart/preview');
    expect((init as RequestInit).method).toBe('POST');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.total).toBe('12.00');
      expect(result.value.lineItems[0]?.label).toBe('Latte');
    }
  });

  it('previewCart returns notDeployed on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const result = await previewCart({});
    expect(result.kind).toBe('notDeployed');
  });

  it('previewCart returns forbidden on 403', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'dev_layer1_disabled' }));
    const result = await previewCart({});
    expect(result.kind).toBe('forbidden');
  });

  it('previewCart returns badRequest with server detail on 400', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'cart_invalid', detail: 'merchant.wallet is not base58' }));
    const result = await previewCart({});
    expect(result.kind).toBe('badRequest');
    if (result.kind === 'badRequest') {
      expect(result.message).toContain('merchant.wallet');
    }
  });

  it('approveCart returns cartId and approvalId on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { cartId: 'cart_abc', approvalId: 'apr_xyz' }));
    const result = await approveCart({});
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.cartId).toBe('cart_abc');
      expect(result.value.approvalId).toBe('apr_xyz');
    }
  });

  it('approveCart errors when server omits required fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { cartId: 'only-cart' }));
    const result = await approveCart({});
    expect(result.kind).toBe('error');
  });
});

describe('handleAction (state-only paths)', () => {
  beforeEach(() => {
    __resetPanelStateForTests();
  });

  it('load-sample populates panel cartText with the sample fixture', async () => {
    await handleAction('load-sample');
    expect(__getPanelStateForTests().cartText).toBe(SAMPLE_CART);
  });

  it('clear empties cartText and resets preview state', async () => {
    __resetPanelStateForTests({ phase: 'preview', cartText: 'something', preview: null });
    await handleAction('clear');
    const state = __getPanelStateForTests();
    expect(state.cartText).toBe('');
    expect(state.phase).toBe('compose');
    expect(state.preview).toBeNull();
  });

  it('dismiss-error clears the error message', async () => {
    __resetPanelStateForTests({ error: 'boom' });
    await handleAction('dismiss-error');
    expect(__getPanelStateForTests().error).toBe('');
  });

  it('dismiss-notice clears the notice', async () => {
    __resetPanelStateForTests({ notice: { title: 'a', body: 'b' } });
    await handleAction('dismiss-notice');
    expect(__getPanelStateForTests().notice).toBeNull();
  });

  it('edit returns from preview to compose without losing cartText', async () => {
    __resetPanelStateForTests({ phase: 'preview', cartText: 'kept' });
    await handleAction('edit');
    const state = __getPanelStateForTests();
    expect(state.phase).toBe('compose');
    expect(state.cartText).toBe('kept');
  });
});
