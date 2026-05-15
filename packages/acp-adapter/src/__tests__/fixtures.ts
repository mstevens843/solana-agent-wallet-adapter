import type { AcpCart, AcpLineItem } from '../types.js';

export const MERCHANT_RECIPIENT_MAINNET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
export const MERCHANT_RECIPIENT_DEVNET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

export function lineItem(overrides: Partial<AcpLineItem> = {}): AcpLineItem {
  return Object.freeze({
    id: 'li_1',
    name: 'Premium Subscription',
    quantity: 1,
    unitAmount: '9.99',
    currency: 'USD',
    ...overrides,
  } as AcpLineItem);
}

export function mainnetUsdcCart(overrides: Partial<AcpCart> = {}): AcpCart {
  return freezeCart({
    id: 'cart_mainnet_001',
    cartVersion: '1',
    merchant: {
      id: 'merchant_acme',
      name: 'Acme Inc.',
      recipient: MERCHANT_RECIPIENT_MAINNET,
    },
    lineItems: [lineItem(), lineItem({ id: 'li_2', name: 'Add-on', unitAmount: '5.00', quantity: 2 })],
    totalAmount: '19.99',
    currency: 'USD',
    paymentToken: 'USDC',
    cluster: 'mainnet-beta',
    expiresAt: '2099-01-01T00:00:00.000Z',
    memo: 'Order #123',
    ...overrides,
  });
}

export function devnetUsdcCart(overrides: Partial<AcpCart> = {}): AcpCart {
  return freezeCart({
    id: 'cart_devnet_001',
    cartVersion: '1',
    merchant: {
      id: 'merchant_acme',
      name: 'Acme Inc.',
      recipient: MERCHANT_RECIPIENT_DEVNET,
    },
    lineItems: [lineItem()],
    totalAmount: '9.99',
    currency: 'USD',
    paymentToken: 'USDC',
    cluster: 'devnet',
    ...overrides,
  });
}

export function mainnetUsdtCart(overrides: Partial<AcpCart> = {}): AcpCart {
  return freezeCart({
    ...mainnetUsdcCart(),
    paymentToken: 'USDT',
    ...overrides,
  });
}

export function mainnetSolCart(overrides: Partial<AcpCart> = {}): AcpCart {
  return freezeCart({
    ...mainnetUsdcCart({
      id: 'cart_sol_001',
      totalAmount: '20.00',
      lineItems: [{ id: 'li', name: 'SOL priced item', quantity: 1, unitAmount: '20.00', currency: 'USD' }],
      paymentToken: 'SOL',
      paymentAmount: '0.10',
      paymentTokenMint: undefined,
    }),
    ...overrides,
  });
}

export function expiredCart(): AcpCart {
  return freezeCart({
    ...mainnetUsdcCart(),
    expiresAt: '2000-01-01T00:00:00.000Z',
  });
}

// Raw cart-shaped object that uses the colloquial 'mainnet' alias so we can
// exercise the parser's CLUSTER_ALIASES path. Returns the object as-is; the
// parser is expected to normalize cluster to 'mainnet-beta'.
export function rawAliasedMainnetCart(): Record<string, unknown> {
  return {
    id: 'cart_alias_001',
    cartVersion: '1',
    merchant: {
      id: 'merchant_acme',
      name: 'Acme Inc.',
      recipient: MERCHANT_RECIPIENT_MAINNET,
    },
    lineItems: [{ id: 'li', name: 'thing', quantity: 1, unitAmount: '1.00', currency: 'USD' }],
    totalAmount: '1.00',
    currency: 'USD',
    paymentToken: 'USDC',
    cluster: 'mainnet',
  };
}

export const SAMPLE_CART_JSON = JSON.stringify(mainnetUsdcCart());

function freezeCart(cart: AcpCart): AcpCart {
  const lineItems = Object.freeze(cart.lineItems.map((item) => Object.freeze({ ...item })));
  return Object.freeze({
    ...cart,
    merchant: Object.freeze({ ...cart.merchant }),
    lineItems,
    ...(cart.metadata ? { metadata: Object.freeze({ ...cart.metadata }) } : {}),
  });
}
