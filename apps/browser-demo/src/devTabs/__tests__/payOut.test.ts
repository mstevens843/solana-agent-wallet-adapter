import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAY_OUT_APPROVAL_CREATED_EVENT } from '../../payOutApprovalEvents.js';
import { setConnectedAddress } from '../../walletState.js';

// Minimal stubs to let payOut.ts load in vitest's default node env. The CSS
// import is gated on `typeof document !== 'undefined'`, so leaving document
// unset prevents the Vite style-injection side effect, while letting us
// import the pure renderers and the fetch wrappers.

import {
  SAMPLE_CART,
  __getPanelStateForTests,
  __resetPanelStateForTests,
  approveCart,
  approveCartLocally,
  escapeHtml,
  handleAction,
  normalizePreview,
  parseCartText,
  previewCart,
  previewCartLocally,
  renderPayOutPanel,
  sampleCartForRecipient,
  shortAddress,
} from '../payOut.js';

const TEST_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const SOL_CART = {
  id: 'cart_sol_001',
  cartVersion: '1',
  merchant: { id: 'merchant_acme', name: 'Acme Coffee', recipient: TEST_WALLET },
  lineItems: [{ id: 'li_1', name: 'SOL checkout', quantity: 1, unitAmount: '20.00', currency: 'USD' }],
  totalAmount: '20.00',
  currency: 'USD',
  paymentToken: 'SOL',
  paymentAmount: '0.10',
  cluster: 'mainnet-beta',
  memo: 'SOL order',
};

afterEach(() => {
  setConnectedAddress(undefined);
});

function makePreviewEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cart: {
      id: 'cart_test_001',
      cartVersion: '1',
      merchant: { id: 'm1', name: 'Acme Coffee', recipient: TEST_WALLET },
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
      recipient: TEST_WALLET,
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
    expect(shortAddress(TEST_WALLET)).toBe('4fTq…MoHd');
    expect(shortAddress('short')).toBe('short');
    expect(shortAddress('')).toBe('');
  });

  it('parseCartText returns parsed JSON', () => {
    expect(parseCartText('{"a":1}')).toEqual({ a: 1 });
  });

  it('parseCartText rejects empty input with a friendly message', () => {
    expect(() => parseCartText('   ')).toThrow(/Create, load, or import a merchant payment/);
  });

  it('parseCartText rejects malformed JSON', () => {
    expect(() => parseCartText('{not json}')).toThrow(/not valid JSON/);
  });

  it('accepts .25 decimal formatting as 25 cents in local preview validation', () => {
    const cart = {
      ...(parseCartText(SAMPLE_CART) as Record<string, unknown>),
      lineItems: [{ id: 'li_1', name: 'Quarter', quantity: 1, unitAmount: '.25', currency: 'USD' }],
      totalAmount: '.25',
    };
    const result = previewCartLocally(cart);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.totalAmount).toBe('.25');
      expect(result.value.transferAmount).toBe('.25');
    }
  });

  it('SAMPLE_CART parses back to a structurally-valid AcpCart shape', () => {
    const parsed = parseCartText(SAMPLE_CART) as Record<string, unknown>;
    expect(parsed.id).toBe('cart_demo_001');
    expect(parsed.cartVersion).toBe('1');
    expect((parsed.merchant as Record<string, unknown>).recipient).toBe(TEST_WALLET);
    expect(Array.isArray(parsed.lineItems)).toBe(true);
    expect(parsed.totalAmount).toBe('17.80');
    expect(parsed.paymentToken).toBe('USDC');
    expect(parsed.cluster).toBe('mainnet-beta');
  });

  it('builds the demo cart for the provided recipient', () => {
    const parsed = parseCartText(sampleCartForRecipient(TEST_WALLET)) as Record<string, unknown>;
    expect((parsed.merchant as Record<string, unknown>).recipient).toBe(TEST_WALLET);
  });
});

describe('normalizePreview', () => {
  it('accepts the server envelope { cart, transfer, totalFiat, resolvedTokenMint }', () => {
    const result = normalizePreview(makePreviewEnvelope());
    expect(result.cartId).toBe('cart_test_001');
    expect(result.merchant.name).toBe('Acme Coffee');
    expect(result.merchant.recipient).toBe(TEST_WALLET);
    expect(result.lineItems).toHaveLength(3);
    expect(result.lineItems[0]).toEqual({ name: 'Latte', quantity: 2, unitAmount: '6.00' });
    expect(result.lineItems[2]).toEqual({ name: 'Tax', quantity: 1, unitAmount: '1.30' });
    expect(result.totalAmount).toBe('17.80');
    expect(result.totalFiat).toBe('USD 17.80');
    expect(result.paymentToken).toBe('USDC');
    expect(result.resolvedTokenMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(result.cluster).toBe('mainnet-beta');
    expect(result.memo).toBe('demo');
    expect(result.recipient).toBe(TEST_WALLET);
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

describe('browser-local ACP fallback', () => {
  it('builds a readable preview without server routes', () => {
    const result = previewCartLocally(parseCartText(SAMPLE_CART));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.cartId).toBe('cart_demo_001');
      expect(result.value.merchant.name).toBe('Acme Coffee');
      expect(result.value.totalAmount).toBe('17.80');
      expect(result.value.paymentToken).toBe('USDC');
      expect(result.value.recipient).toBe(TEST_WALLET);
      expect(result.value.resolvedTokenMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    }
  });

  it('builds a SOL preview with native transfer amount and USD total', () => {
    const result = previewCartLocally(SOL_CART);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.paymentToken).toBe('SOL');
      expect(result.value.totalAmount).toBe('20.00');
      expect(result.value.totalFiat).toBe('USD 20.00');
      expect(result.value.transferAmount).toBe('0.10');
      expect(result.value.resolvedTokenMint).toBe('SOL');
    }
  });

  it('rejects locally when line item totals do not match', () => {
    const badCart = {
      ...(parseCartText(SAMPLE_CART) as Record<string, unknown>),
      totalAmount: '999.00',
    };
    const result = previewCartLocally(badCart);
    expect(result.kind).toBe('badRequest');
    if (result.kind === 'badRequest') {
      expect(result.message).toContain('does not match line items');
    }
  });

  it('creates a browser approval card when the wallet is connected', () => {
    setConnectedAddress(TEST_WALLET);
    const previewResult = previewCartLocally(parseCartText(SAMPLE_CART));
    expect(previewResult.kind).toBe('ok');
    if (previewResult.kind !== 'ok') return;

    const result = approveCartLocally(parseCartText(SAMPLE_CART), previewResult.value);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.localOnly).toBe(true);
      expect(result.value.approvalId).toMatch(/^browser-acp_/);
      expect(result.value.cartId).toBe('cart_demo_001');
      expect(result.value.approval).toEqual(expect.objectContaining({
        walletAddress: TEST_WALLET,
        kind: 'transfer_spl',
        status: 'ready',
      }));
    }
  });

  it('creates a browser SOL approval as transfer_sol', () => {
    setConnectedAddress(TEST_WALLET);
    const previewResult = previewCartLocally(SOL_CART);
    expect(previewResult.kind).toBe('ok');
    if (previewResult.kind !== 'ok') return;

    const result = approveCartLocally(SOL_CART, previewResult.value);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.approval).toEqual(expect.objectContaining({
        walletAddress: TEST_WALLET,
        kind: 'transfer_sol',
        amount: '0.10',
        token: 'SOL',
      }));
      expect((result.value.approval as { params?: Record<string, unknown> }).params).toMatchObject({
        recipient: TEST_WALLET,
        amountSol: '0.10',
      });
    }
  });
});

describe('renderPayOutPanel', () => {
  beforeEach(() => {
    __resetPanelStateForTests();
  });

  it('compose phase renders normal inputs as the primary user path', () => {
    const html = renderPayOutPanel();
    expect(html).toContain('Create a merchant payment');
    expect(html).toContain('data-dev-tab-use-cases="agent-payments-pay-merchant"');
    expect(html).toContain('AI fills a checkout cart');
    expect(html).toContain('Payment details');
    expect(html).toContain('Merchant name');
    expect(html).toContain('Recipient wallet');
    expect(html).toContain('Payment token');
    expect(html).toContain('data-select-picker-label="SOL"');
    expect(html).not.toContain('Solana (SOL)');
    expect(html).toContain('Line items');
    expect(html).toContain('data-pay-out-action="add-line-item"');
    expect(html).toContain('data-pay-out-action="remove-line-item:0"');
    expect(html).not.toContain('pay-out-amount-field');
    expect(html).not.toContain('data-pay-out-line-estimate');
    expect(html).toContain('Type payment details');
    expect(html).toContain('Paste cart JSON');
    expect(html).toContain('Load sample cart');
    expect(html).not.toContain('id="pay-out-cart-input"');
    expect(html).toContain('data-pay-out-action="preview"');
    expect(html).toContain('data-pay-out-action="entry-json"');
    expect(html).toContain('data-pay-out-action="load-sample"');
    expect(html).not.toContain('data-pay-out-preview');
  });

  it('compose phase renders raw JSON only in the second tab', () => {
    __resetPanelStateForTests({ entryMode: 'json' });
    const html = renderPayOutPanel();
    expect(html).toContain('Paste cart JSON');
    expect(html).toContain('Developer import');
    expect(html).toContain('id="pay-out-cart-input"');
    expect(html).toContain('data-pay-out-action="preview-json"');
    expect(html).toContain('data-pay-out-action="paste-clipboard"');
    expect(html).toContain('data-pay-out-action="entry-details"');
  });

  it('compose phase fills the normal inputs when a request is loaded', () => {
    __resetPanelStateForTests({ cartText: SAMPLE_CART });
    const html = renderPayOutPanel();
    expect(html).toContain('Normal entry');
    expect(html).toContain('Acme Coffee');
    expect(html).toContain('17.80 USDC');
    expect(html).toContain('Latte');
    expect(html).toContain('Review merchant payment');
    expect(html).toContain('Clear payment');
  });

  it('compose phase keeps line items and shows a SOL estimate when SOL is selected', () => {
    __resetPanelStateForTests({
      draft: {
        merchantName: 'Acme Coffee',
        recipient: TEST_WALLET,
        paymentToken: 'SOL',
        paymentAmount: '',
        memo: '',
        lineItems: [{ name: 'Latte', quantity: '1', unitAmount: '0.01' }],
        solPriceStatus: 'ready',
        solUsdPerToken: 200,
        solPriceSource: 'pyth',
        solPriceCheckedAt: '2026-05-15T00:00:00.000Z',
      },
    });
    const html = renderPayOutPanel();
    expect(html).toContain('data-payment-token="SOL"');
    expect(html).toContain('Line items');
    expect(html).toContain('data-pay-out-action="add-line-item"');
    expect(html).toContain('data-pay-out-action="remove-line-item:0"');
    expect(html).toContain('pay-out-amount-field');
    expect(html).toContain('data-pay-out-line-estimate');
    expect(html).toContain('$2.0000');
    expect(html).toContain('0.01 SOL');
    expect(html).toContain('$2.0000 USD');
    expect(html).toContain('Estimated total');
    expect(html).toContain('SOL');
    expect(html).not.toContain('Solana (SOL)');
  });

  it('preview phase renders one row per line item, total, USD subtitle and the confirm button', () => {
    __resetPanelStateForTests({
      phase: 'preview',
      cartText: SAMPLE_CART,
      preview: {
        cartId: 'cart_x',
        cartVersion: '1',
        merchant: { name: 'Acme Coffee', recipient: TEST_WALLET },
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
        recipient: TEST_WALLET,
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
    expect(html).not.toContain('mainnet-beta');
    expect(html).not.toContain('<dt>Cluster</dt>');
    expect(html).toContain('4fTq…MoHd');
    expect(html).toContain('data-pay-out-action="confirm"');
    expect(html).toContain('Change payment');
    expect(html).toContain('Add to Needs Approval');
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
    setConnectedAddress(undefined);
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
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ cart: {} });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.cartId).toBe('cart_abc');
      expect(result.value.approvalId).toBe('apr_xyz');
      expect(result.value.cartHash).toBe('abc123');
      expect(result.value.approval).toEqual({ id: 'apr_xyz', kind: 'manual_review' });
    }
  });

  it('sends the connected wallet address for local dev approve routes', async () => {
    setConnectedAddress('DevWallet1111111111111111111111111111111111');
    fetchMock.mockResolvedValueOnce(jsonResponse(201, {
      approval: { id: 'browser-acp_123', kind: 'transfer_spl' },
      cartId: 'cart_abc',
      localOnly: true,
    }));
    const result = await approveCart({ id: 'cart_abc' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      cart: { id: 'cart_abc' },
      walletAddress: 'DevWallet1111111111111111111111111111111111',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.localOnly).toBe(true);
      expect(result.value.approvalId).toBe('browser-acp_123');
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
    setConnectedAddress(TEST_WALLET);
    await handleAction('load-sample');
    expect(__getPanelStateForTests().cartText).toBe(sampleCartForRecipient(TEST_WALLET));
  });

  it('load-sample refuses to populate a recipient without a connected wallet', async () => {
    await handleAction('load-sample');
    const state = __getPanelStateForTests();
    expect(state.cartText).toBe('');
    expect(state.error).toContain('Connect a wallet');
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

  it('add-line-item appends a blank line item to the draft', async () => {
    __resetPanelStateForTests({
      draft: {
        merchantName: 'Acme Coffee',
        recipient: TEST_WALLET,
        paymentToken: 'USDC',
        paymentAmount: '',
        memo: '',
        lineItems: [{ name: 'Latte', quantity: '1', unitAmount: '6.00' }],
        solPriceStatus: 'idle',
      },
    });

    await handleAction('add-line-item');

    const state = __getPanelStateForTests();
    expect(state.draft?.lineItems).toHaveLength(2);
    expect(state.draft?.lineItems[1]).toEqual({ name: '', quantity: '1', unitAmount: '' });
  });

  it('remove-line-item removes the requested row and leaves one blank row when empty', async () => {
    __resetPanelStateForTests({
      draft: {
        merchantName: 'Acme Coffee',
        recipient: TEST_WALLET,
        paymentToken: 'USDC',
        paymentAmount: '',
        memo: '',
        lineItems: [{ name: 'Latte', quantity: '1', unitAmount: '6.00' }],
        solPriceStatus: 'idle',
      },
    });

    await handleAction('remove-line-item:0');

    expect(__getPanelStateForTests().draft?.lineItems).toEqual([{ name: '', quantity: '1', unitAmount: '' }]);
  });
});

describe('handleAction browser-local fallback paths', () => {
  type FetchMock = ReturnType<typeof vi.fn>;
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    __resetPanelStateForTests();
    setConnectedAddress(TEST_WALLET);
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it('reviews the request locally when the preview API route is missing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    __resetPanelStateForTests({ cartText: SAMPLE_CART });

    await handleAction('preview');

    const state = __getPanelStateForTests();
    expect(state.phase).toBe('preview');
    expect(state.preview?.cartId).toBe('cart_demo_001');
    expect(state.notice?.title).toBe('Using browser-local approvals');
  });

  it('dispatches a local approval when the approve API route is missing', async () => {
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

    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const previewResult = previewCartLocally(parseCartText(SAMPLE_CART));
    expect(previewResult.kind).toBe('ok');
    if (previewResult.kind !== 'ok') return;
    __resetPanelStateForTests({
      phase: 'preview',
      cartText: SAMPLE_CART,
      preview: previewResult.value,
    });

    try {
      await handleAction('confirm');
    } finally {
      if (typeof previousCustomEvent === 'undefined') {
        delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;
      }
      delete (globalThis as { window?: Window }).window;
    }

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual(expect.objectContaining({
      source: 'acp_outbound',
      cartId: 'cart_demo_001',
      localOnly: true,
    }));
    expect((details[0] as { approvalId?: unknown }).approvalId).toEqual(expect.stringMatching(/^browser-acp_/));
    expect((details[0] as { approval?: Record<string, unknown> }).approval).toEqual(expect.objectContaining({
      walletAddress: TEST_WALLET,
      kind: 'transfer_spl',
    }));
    expect(__getPanelStateForTests().phase).toBe('compose');
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
    setConnectedAddress(undefined);
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
    setConnectedAddress('DevWallet1111111111111111111111111111111111');
    const details: unknown[] = [];
    target.addEventListener(PAY_OUT_APPROVAL_CREATED_EVENT, (event) => {
      details.push((event as CustomEvent).detail);
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(201, {
      approval: { id: 'browser-acp_pay_out_001', kind: 'transfer_spl' },
      cartId: 'cart_demo_001',
      cartHash: 'cart_hash_001',
      localOnly: true,
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
      approvalId: 'browser-acp_pay_out_001',
      cartId: 'cart_demo_001',
      cartHash: 'cart_hash_001',
      approval: { id: 'browser-acp_pay_out_001', kind: 'transfer_spl' },
      localOnly: true,
    }]);
    expect(__getPanelStateForTests().phase).toBe('compose');
    expect(__getPanelStateForTests().cartText).toBe('');
  });
});
