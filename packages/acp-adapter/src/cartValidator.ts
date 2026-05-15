import { isValidSolanaAddress } from './addressValidation.js';
import {
  DECIMAL_AMOUNT_REGEX,
  DEFAULT_ALLOWED_TOKEN_MINTS,
  DEFAULT_MAX_LINE_ITEMS,
  DEFAULT_MAX_QUANTITY_PER_LINE_ITEM,
  DEFAULT_MAX_TOTAL_AMOUNT_USD,
  SYMBOL_TO_DEFAULT_MINT,
} from './constants.js';
import { AcpValidationError } from './errors.js';
import type {
  AcpCart,
  AcpCartValidationOptions,
  AcpCartValidationResult,
  AcpCluster,
  AcpPaymentToken,
} from './types.js';

const TOTAL_TOLERANCE = 0.005;

export function validateAcpCart(
  cart: AcpCart,
  opts: AcpCartValidationOptions = {},
): AcpCartValidationResult {
  assertNoForbiddenFields(cart, '$');

  if (!isValidSolanaAddress(cart.merchant.recipient)) {
    throw new AcpValidationError(
      'invalid_recipient',
      'Merchant recipient must be a base58 Solana address.',
      '$.merchant.recipient',
    );
  }

  if (cart.lineItems.length === 0) {
    throw new AcpValidationError('empty_cart', 'Cart must include at least one line item.', '$.lineItems');
  }
  const maxLineItems = opts.maxLineItems ?? DEFAULT_MAX_LINE_ITEMS;
  if (cart.lineItems.length > maxLineItems) {
    throw new AcpValidationError(
      'too_many_line_items',
      `Cart must include at most ${maxLineItems} line items.`,
      '$.lineItems',
    );
  }

  let computedTotal = 0;
  cart.lineItems.forEach((item, index) => {
    const itemPath = `$.lineItems[${index}]`;
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new AcpValidationError('invalid_quantity', 'Quantity must be a positive integer.', `${itemPath}.quantity`);
    }
    if (item.quantity > DEFAULT_MAX_QUANTITY_PER_LINE_ITEM) {
      throw new AcpValidationError(
        'invalid_quantity',
        `Quantity must be ≤ ${DEFAULT_MAX_QUANTITY_PER_LINE_ITEM}.`,
        `${itemPath}.quantity`,
      );
    }
    if (!DECIMAL_AMOUNT_REGEX.test(item.unitAmount)) {
      throw new AcpValidationError('invalid_amount', 'unitAmount must be a positive decimal string.', `${itemPath}.unitAmount`);
    }
    const unit = Number(item.unitAmount);
    if (!Number.isFinite(unit) || unit < 0) {
      throw new AcpValidationError('invalid_amount', 'unitAmount must be finite and non-negative.', `${itemPath}.unitAmount`);
    }
    computedTotal += unit * item.quantity;
  });

  if (!DECIMAL_AMOUNT_REGEX.test(cart.totalAmount)) {
    throw new AcpValidationError('invalid_amount', 'totalAmount must be a positive decimal string.', '$.totalAmount');
  }
  const total = Number(cart.totalAmount);
  if (!Number.isFinite(total)) {
    throw new AcpValidationError('invalid_amount', 'totalAmount must be finite.', '$.totalAmount');
  }
  if (total <= 0) {
    throw new AcpValidationError('total_non_positive', 'totalAmount must be greater than zero.', '$.totalAmount');
  }
  const maxTotal = opts.maxTotalAmount ?? DEFAULT_MAX_TOTAL_AMOUNT_USD;
  if (total > maxTotal) {
    throw new AcpValidationError(
      'total_exceeds_cap',
      `totalAmount must be ≤ ${maxTotal}.`,
      '$.totalAmount',
    );
  }
  if (Math.abs(total - computedTotal) > TOTAL_TOLERANCE) {
    throw new AcpValidationError(
      'total_mismatch',
      `totalAmount (${total}) does not match sum of line items (${computedTotal.toFixed(2)}).`,
      '$.totalAmount',
    );
  }

  if (cart.expiresAt !== undefined) {
    const expiresAt = Date.parse(cart.expiresAt);
    if (Number.isNaN(expiresAt)) {
      throw new AcpValidationError('invalid_timestamp', 'expiresAt must be an ISO-8601 timestamp.', '$.expiresAt');
    }
    const now = (opts.now ?? new Date()).getTime();
    if (expiresAt <= now) {
      throw new AcpValidationError('cart_expired', 'Cart has expired.', '$.expiresAt');
    }
  }

  const resolvedTokenMint = resolveTokenMint(cart, opts);

  return Object.freeze({
    ok: true,
    cart,
    totalFiat: round2(total),
    resolvedTokenMint,
  });
}

// Scoped guard for secrets/authority. Mirrors workflow's assertNoForbiddenWorkflowSecrets
// but lives inside the adapter so callers without workflow can still get the protection.
function assertNoForbiddenFields(value: unknown, path: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenFields(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (
      normalized.includes('privatekey') ||
      normalized.includes('secretkey') ||
      normalized.includes('seedphrase') ||
      normalized.includes('mnemonic') ||
      normalized === 'delegatedsigner'
    ) {
      throw new AcpValidationError(
        'forbidden_secret',
        `${path}.${key} is not accepted by ACP carts.`,
        `${path}.${key}`,
      );
    }
    if (
      (normalized.includes('approvalauthority') || normalized.includes('signingauthority') || normalized.includes('authority')) &&
      indicatesUnlimitedAuthority(entry)
    ) {
      throw new AcpValidationError(
        'forbidden_authority',
        `${path}.${key} cannot grant unlimited approval authority.`,
        `${path}.${key}`,
      );
    }
    assertNoForbiddenFields(entry, `${path}.${key}`);
  }
}

function indicatesUnlimitedAuthority(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized.includes('unlimited') ||
    normalized.includes('unrestricted') ||
    normalized.includes('delegatedsigner') ||
    normalized.includes('serversigner')
  );
}

function resolveTokenMint(cart: AcpCart, opts: AcpCartValidationOptions): string {
  const allowed = (opts.allowedTokenMints ?? DEFAULT_ALLOWED_TOKEN_MINTS)[cart.cluster] ?? [];
  if (allowed.length === 0) {
    throw new AcpValidationError(
      'unsupported_token_for_cluster',
      `No allowed token mints configured for cluster "${cart.cluster}".`,
      '$.cluster',
    );
  }

  if (cart.paymentTokenMint !== undefined) {
    if (!allowed.includes(cart.paymentTokenMint)) {
      throw new AcpValidationError(
        'invalid_token_mint',
        `paymentTokenMint is not allowlisted for cluster "${cart.cluster}".`,
        '$.paymentTokenMint',
      );
    }
    if (opts.allowedTokenMints === undefined) {
      // Default allowlist: enforce symbol↔mint mapping so cart can't claim
      // USDC but ship a USDT mint. Open allowlist override skips this strictness.
      assertSymbolMintMatches(cart.cluster, cart.paymentToken, cart.paymentTokenMint);
    }
    return cart.paymentTokenMint;
  }

  if (opts.allowedTokenMints !== undefined) {
    throw new AcpValidationError(
      'invalid_token_mint',
      'paymentTokenMint is required when a custom allowedTokenMints override is provided.',
      '$.paymentTokenMint',
    );
  }

  const mapping = SYMBOL_TO_DEFAULT_MINT[cart.cluster];
  const mint = mapping?.[cart.paymentToken];
  if (!mint) {
    throw new AcpValidationError(
      'unsupported_token_for_cluster',
      `Token "${cart.paymentToken}" is not supported on cluster "${cart.cluster}".`,
      '$.paymentToken',
    );
  }
  return mint;
}

function assertSymbolMintMatches(cluster: AcpCluster, symbol: AcpPaymentToken, mint: string): void {
  const expected = SYMBOL_TO_DEFAULT_MINT[cluster]?.[symbol];
  if (!expected) {
    throw new AcpValidationError(
      'unsupported_token_for_cluster',
      `Token "${symbol}" is not supported on cluster "${cluster}".`,
      '$.paymentToken',
    );
  }
  if (expected !== mint) {
    throw new AcpValidationError(
      'token_mint_cluster_mismatch',
      `paymentTokenMint does not match canonical ${symbol} mint for cluster "${cluster}".`,
      '$.paymentTokenMint',
    );
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
