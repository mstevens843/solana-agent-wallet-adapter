import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAY_OUT_APPROVAL_CREATED_EVENT } from '../../payOutApprovalEvents.js';

// Minimal stubs to let payOut.ts load in vitest's default node env. The CSS
// import is gated on `typeof document !== 'undefined'`, so leaving document
// unset prevents the Vite style-injection side effect, while letting us
// import the pure renderers and the fetch wrappers.

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

function makePreviewEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cart: {
      id: 'cart_test_001',
      cartVersion: '1',
      merchant: { id: 'm1', name: 'Acme Coffee', recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M' },
      lineItems: [
        { id: 'li_001', name: 'Latte', quantity: 2, unitAmount: '6.00', currency: 'USD' },
        { id: 'li_002', name: 'Croissant', quantity: 1, unitAmount: '4.50', currency: 'USD' },
        { id: 'li_003', name: 'Tax', quantity: 1, unitAmount: '1.30', currency: 'USD' },
      ],
      totalAmount: '17.80',
      currency: 'USD',
      paymentToken: 'USDC',
      cluster: 'mainnet-beta',
      memo: 'demo',
    },
    transfer: {
      token: 'USDC',
      recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
      amount: '17.80',
      note: 'demo',
    },
    totalFiat: 17.8,
    resolvedTokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    ...overrides,
  };
}

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
    expect(() => parseCartText('   ')).toThrow(/Choose or import a payment request/);
  });

  it('parseCartText rejects malformed JSON', () => {
    expect(() => parseCartText('{not json}')).toThrow(/not valid JSON/);
  });

  it('SAMPLE_CART parses back to a structurally-valid AcpCart shape', () => {
    const parsed = parseCartText(SAMPLE_CART) as Record<string, unknown>;
    expect(parsed.id).toBe('cart_demo_001');
    expect(parsed.cartVersion).toBe('1');
    expect((parsed.merchant as Record<string, unknown>).recipient).toMatch(/^[A-Za-z0-9]+$/);
    expect(Array.isArray(parsed.lineItems)).toBe(true);
    expect(parsed.totalAmount).toBe('17.80');
    expect(parsed.paymentToken).toBe('USDC');
    expect(parsed.cluster).toBe('mainnet-beta');
  });
});

describe('normalizePreview', () => {
  it('accepts the server envelope { cart, transfer, totalFiat, resolvedTokenMint }', () => {
    const result = normalizePreview(makePreviewEnvelope());
    expect(result.cartId).toBe('cart_test_001');
    expect(result.merchant.name).toBe('Acme Coffee');
    expect(result.merchant.recipient).toBe('7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M');
    expect(result.lineItems).toHaveLength(3);
    expect(result.lineItems[0]).toEqual({ name: 'Latte', quantity: 2, unitAmount: '6.00' });
    expect(result.lineItems[2]).toEqual({ name: 'Tax', quantity: 1, unitAmount: '1.30' });
    expect(result.totalAmount).toBe('17.80');
    expect(result.totalFiat).toBe('USD 17.80');
    expect(result.paymentToken).toBe('USDC');
    expect(result.resolvedTokenMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(result.cluster).toBe('mainnet-beta');
    expect(result.memo).toBe('demo');
    expect(result.recipient).toBe('7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M');
  });

  it('drops malformed line items but keeps the rest', () => {
    const envelope = makePreviewEnvelope({
      cart: {
        ...(makePreviewEnvelope().cart as Record<string, unknown>),
        lineItems: [
          { id: 'a', name: 'Latte', quantity: 2, unitAmount: '6.00', currency: 'USD' },
          { id: 'b', name: '', unitAmount: 'oops', currency: 'USD' },
          'garbage',
          null,
          { id: 'c', name: 'Tax', quantity: 1, unitAmount: '1.30', currency: 'USD' },
        ],
      },
    });
    const result = normalizePreview(envelope);
    expect(result.lineItems).toHaveLength(2);
    expect(result.lineItems.map((it) => it.name)).toEqual(['Latte', 'Tax']);
  });

  it('throws when cart or transfer is missing', () => {
    expect(() => normalizePreview({ transfer: {} })).toThrow(/missing the cart/);
    expect(() => normalizePreview({ cart: {} })).toThrow(/missing the transfer/);
    expect(() => normalizePreview(null)).toThrow();
  });

  it('throws when totalAmount or transfer.recipient is missing', () => {
    const envelope = makePreviewEnvelope({
      cart: { ...(makePreviewEnvelope().cart as Record<string, unknown>), totalAmount: '' },
    });
    expect(() => normalizePreview(envelope)).toThrow();
  });

  it('formats totalFiat from numeric or string sources', () => {
    expect(normalizePreview(makePreviewEnvelope({ totalFiat: 19.99 })).totalFiat).toBe('USD 19.99');
    expect(normalizePreview(makePreviewEnvelope({ totalFiat: '12.5' })).totalFiat).toBe('USD 12.50');
  });
});

describe('renderPayOutPanel', () => {
  beforeEach(() => {
    __resetPanelStateForTests();
  });

  it('compose phase renders the user-facing request picker and advanced import', () => {
    const html = renderPayOutPanel();
    expect(html).toContain('Choose a request to review');
    expect(html).toContain('Use demo request');
    expect(html).toContain('No payment request yet');
    expect(html).toContain('Import raw ACP request');
    expect(html).toContain('id="pay-out-cart-input"');
    expect(html).toContain('data-pay-out-action="preview"');
    expect(html).toContain('data-pay-out-action="load-sample"');
    expect(html).not.toContain('data-pay-out-preview');
  });

  it('compose phase renders selected payment request details when a request is loaded', () => {
    __resetPanelStateForTests({ cartText: SAMPLE_CART });
    const html = renderPayOutPanel();
    expect(html).toContain('Selected request');
    expect(html).toContain('Acme Coffee');
    expect(html).toContain('17.80 USDC');
    expect(html).toContain('Latte');
    expect(html).toContain('Review payment request');
    expect(html).toContain('Clear request');
  });

  it('preview phase renders one row per line item, total, USD subtitle and the confirm button', () => {
    __resetPanelStateForTests({
      phase: 'preview',
      cartText: SAMPLE_CART,
      preview: {
        cartId: 'cart_x',
        cartVersion: '1',
        merchant: { name: 'Acme Coffee', recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M' },
        lineItems: [
          { name: 'Latte', quantity: 2, unitAmount: '6.00' },
          { name: 'Croissant', quantity: 1, unitAmount: '4.50' },
          { name: 'Tax', quantity: 1, unitAmount: '1.30' },
        ],
        totalAmount: '17.80',
        totalFiat: 'USD 17.80',
        paymentToken: 'USDC',
        resolvedTokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        cluster: 'mainnet-beta',
        recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
        transferAmount: '17.80',
        memo: 'demo',
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
    expect(html).toContain('USD 17.80');
    expect(html).toContain('mainnet-beta');
    expect(html).toContain('7tQA…Yc8M');
    expect(html).toContain('data-pay-out-action="confirm"');
    expect(html).toContain('Change request');
    expect(html).toContain('Send to Needs Approval');
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

describe('previewCart fetch behavior', () => {
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

  it('previewCart returns ok with normalized display preview on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { preview: makePreviewEnvelope() }));
    const result = await previewCart({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/acp/cart/preview');
    expect((init as RequestInit).method).toBe('POST');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.totalAmount).toBe('17.80');
      expect(result.value.lineItems[0]?.name).toBe('Latte');
      expect(result.value.totalFiat).toBe('USD 17.80');
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
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'parse_error:invalid_json', message: 'merchant.recipient is not base58' }));
    const result = await previewCart({});
    expect(result.kind).toBe('badRequest');
    if (result.kind === 'badRequest') {
      expect(result.message).toContain('merchant.recipient');
    }
  });
});

describe('approveCart fetch behavior', () => {
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

  it('reads approval.id and cartId on 201', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, {
      approval: { id: 'apr_xyz', kind: 'manual_review' },
      cartId: 'cart_abc',
      cartHash: 'abc123',
    }));
    const result = await approveCart({});
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.cartId).toBe('cart_abc');
      expect(result.value.approvalId).toBe('apr_xyz');
      expect(result.value.cartHash).toBe('abc123');
    }
  });

  it('errors when approval is missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { cartId: 'only-cart' }));
    const result = await approveCart({});
    expect(result.kind).toBe('error');
  });

  it('errors when approval.id is missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { approval: { kind: 'manual_review' }, cartId: 'c' }));
    const result = await approveCart({});
    expect(result.kind).toBe('error');
  });

  it('returns notDeployed on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const result = await approveCart({});
    expect(result.kind).toBe('notDeployed');
  });

  it('returns forbidden on 403', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'dev_layer1_disabled' }));
    const result = await approveCart({});
    expect(result.kind).toBe('forbidden');
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

describe('handleAction confirm path', () => {
  type FetchMock = ReturnType<typeof vi.fn>;
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    __resetPanelStateForTests();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    delete (globalThis as { window?: Window }).window;
  });

  function jsonResponse(status: number, body: unknown): Response {
    const text = JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
  }

  it('dispatches an approval-created event after a successful confirm', async () => {
    const previousCustomEvent = globalThis.CustomEvent;
    if (typeof previousCustomEvent === 'undefined') {
      class TestCustomEvent<T = unknown> extends Event {
        detail: T;

        constructor(type: string, init?: CustomEventInit<T>) {
          super(type);
          this.detail = init?.detail as T;
        }
      }
      (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent =
        TestCustomEvent as unknown as typeof CustomEvent;
    }

    const target = new EventTarget();
    (globalThis as { window?: Window }).window = target as unknown as Window;
    const details: unknown[] = [];
    target.addEventListener(PAY_OUT_APPROVAL_CREATED_EVENT, (event) => {
      details.push((event as CustomEvent).detail);
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(201, {
      approval: { id: 'approval_pay_out_001', kind: 'transfer_spl' },
      cartId: 'cart_demo_001',
      cartHash: 'cart_hash_001',
    }));
    __resetPanelStateForTests({
      phase: 'preview',
      cartText: SAMPLE_CART,
      preview: normalizePreview(makePreviewEnvelope()),
    });

    try {
      await handleAction('confirm');
    } finally {
      if (typeof previousCustomEvent === 'undefined') {
        delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;
      }
    }

    expect(details).toEqual([{
      source: 'acp_outbound',
      approvalId: 'approval_pay_out_001',
      cartId: 'cart_demo_001',
      cartHash: 'cart_hash_001',
    }]);
    expect(__getPanelStateForTests().phase).toBe('compose');
    expect(__getPanelStateForTests().cartText).toBe('');
  });
});
