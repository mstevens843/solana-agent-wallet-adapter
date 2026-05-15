import './payOut.css';
import { SOL_MINT_KEY, type PriceUsdSnapshot } from '@solana-agent-wallet-adapter/workflow';
import { dispatchPayOutApprovalCreated } from '../payOutApprovalEvents.js';
import { getUsdPriceForMint } from '../priceCache.js';
import { getConnectedAddress } from '../walletState.js';

export interface AcpLineItemDisplay {
  name: string;
  quantity: number;
  unitAmount: string;
}

export interface AcpPreviewDisplay {
  cartId: string;
  cartVersion: string;
  merchant: { name: string; recipient: string };
  lineItems: AcpLineItemDisplay[];
  totalAmount: string;
  totalFiat: string;
  paymentToken: string;
  resolvedTokenMint: string;
  cluster: string;
  memo?: string;
  recipient: string;
  transferAmount: string;
}

export interface ApprovalCreated {
  cartId: string;
  approvalId: string;
  cartHash?: string;
  approval?: unknown;
  localOnly?: boolean;
}

export type Phase = 'compose' | 'preview';
export type EntryMode = 'details' | 'json';
export type PayOutPaymentToken = 'USDC' | 'USDT' | 'SOL';
type SolPriceStatus = 'idle' | 'loading' | 'ready' | 'error';

interface NoticeInfo {
  title: string;
  body: string;
}

export interface PanelState {
  phase: Phase;
  entryMode: EntryMode;
  draft: PayOutDraft | null;
  cartText: string;
  preview: AcpPreviewDisplay | null;
  error: string;
  notice: NoticeInfo | null;
  busy: boolean;
}

const SAMPLE_CART_FALLBACK_RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const PAYMENT_TOKEN_OPTIONS: readonly PayOutPaymentToken[] = ['USDC', 'USDT', 'SOL'];

function sampleCartPayload(recipient: string): Record<string, unknown> {
  return {
    id: 'cart_demo_001',
    cartVersion: '1',
    merchant: {
      id: 'merchant_acme_coffee',
      name: 'Acme Coffee',
      recipient,
    },
    lineItems: [
      { id: 'item_001', name: 'Latte', quantity: 2, unitAmount: '6.00', currency: 'USD' },
      { id: 'item_002', name: 'Croissant', quantity: 1, unitAmount: '4.50', currency: 'USD' },
      { id: 'item_003', name: 'Tax', quantity: 1, unitAmount: '1.30', currency: 'USD' },
    ],
    totalAmount: '17.80',
    currency: 'USD',
    paymentToken: 'USDC',
    cluster: 'mainnet-beta',
    memo: 'ACP order #demo-001',
  };
}

export function sampleCartForRecipient(recipient: string): string {
  const trimmed = recipient.trim();
  if (!trimmed) throw new Error('Connect a wallet before loading the demo request.');
  return JSON.stringify(sampleCartPayload(trimmed), null, 2);
}

// Sample cart that round-trips through `validateAcpCart`:
//   2 × $6.00 + 1 × $4.50 + 1 × $1.30 = $17.80 (matches totalAmount).
export const SAMPLE_CART = sampleCartForRecipient(SAMPLE_CART_FALLBACK_RECIPIENT);

const panelState: PanelState = {
  phase: 'compose',
  entryMode: 'details',
  draft: null,
  cartText: '',
  preview: null,
  error: '',
  notice: null,
  busy: false,
};

export function __resetPanelStateForTests(next: Partial<PanelState> = {}): void {
  panelState.phase = next.phase ?? 'compose';
  panelState.entryMode = next.entryMode ?? 'details';
  panelState.draft = next.draft ?? null;
  panelState.cartText = next.cartText ?? '';
  panelState.preview = next.preview ?? null;
  panelState.error = next.error ?? '';
  panelState.notice = next.notice ?? null;
  panelState.busy = next.busy ?? false;
}

export function __getPanelStateForTests(): Readonly<PanelState> {
  return panelState;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function shortAddress(address: string): string {
  if (!address) return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function parseCartText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Create, load, or import a payment request before reviewing.');
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cart is not valid JSON: ${message}`);
  }
}

function isStringField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

type JsonRecord = Record<string, unknown>;

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL_AMOUNT_REGEX = /^(?:(?!0\d)\d+(?:\.\d{1,9})?|\.\d{1,9})$/;
const DEFAULT_ACP_CLUSTER = 'mainnet-beta';
const LOCAL_TOTAL_TOLERANCE = 0.005;
const LOCAL_TOKEN_MINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'mainnet-beta': Object.freeze({
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    SOL: SOL_MINT_KEY,
  }),
  devnet: Object.freeze({
    USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    SOL: SOL_MINT_KEY,
  }),
  testnet: Object.freeze({ SOL: SOL_MINT_KEY }),
  localnet: Object.freeze({ SOL: SOL_MINT_KEY }),
});

function isObjectRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function slugId(value: string, fallback: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function formatMoney(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

interface PayOutLineDraft {
  name: string;
  quantity: string;
  unitAmount: string;
}

interface PayOutDraft {
  merchantName: string;
  recipient: string;
  paymentToken: PayOutPaymentToken;
  paymentAmount: string;
  memo: string;
  lineItems: PayOutLineDraft[];
  solPriceStatus: SolPriceStatus;
  solUsdPerToken?: number;
  solPriceSource?: string;
  solPriceCheckedAt?: string;
  solPriceError?: string;
}

function emptyLineDraft(): PayOutLineDraft {
  return { name: '', quantity: '1', unitAmount: '' };
}

function defaultPayOutDraft(): PayOutDraft {
  return {
    merchantName: '',
    recipient: '',
    paymentToken: 'USDC',
    paymentAmount: '',
    memo: '',
    lineItems: [emptyLineDraft(), emptyLineDraft(), emptyLineDraft()],
    solPriceStatus: 'idle',
  };
}

function normalizePaymentToken(value: unknown): PayOutPaymentToken {
  return PAYMENT_TOKEN_OPTIONS.includes(value as PayOutPaymentToken) ? value as PayOutPaymentToken : 'USDC';
}

function cartDraftFromText(cartText: string): PayOutDraft {
  const fallback: PayOutDraft = defaultPayOutDraft();
  const parsed = safeJsonParse(cartText);
  if (!isObjectRecord(parsed)) return fallback;
  const merchant = isObjectRecord(parsed.merchant) ? parsed.merchant : {};
  const metadata = isObjectRecord(parsed.metadata) ? parsed.metadata : {};
  const rawItems = Array.isArray(parsed.lineItems) ? parsed.lineItems : [];
  const lineItems = rawItems
    .filter(isObjectRecord)
    .slice(0, 4)
    .map((item) => ({
      name: isStringField(item.name) ? item.name : '',
      quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity)
        ? String(item.quantity)
        : isStringField(item.quantity)
          ? item.quantity
          : '1',
      unitAmount: isStringField(item.unitAmount) ? item.unitAmount : '',
    }));
  while (lineItems.length < 3) lineItems.push(emptyLineDraft());
  return {
    merchantName: isStringField(merchant.name) ? merchant.name : '',
    recipient: isStringField(merchant.recipient) ? merchant.recipient : '',
    paymentToken: normalizePaymentToken(parsed.paymentToken),
    paymentAmount: isStringField(parsed.paymentAmount) ? parsed.paymentAmount : '',
    memo: isStringField(parsed.memo) ? parsed.memo : '',
    lineItems,
    solPriceStatus: typeof metadata.solUsdPerToken === 'string' && Number.isFinite(Number(metadata.solUsdPerToken))
      ? 'ready'
      : 'idle',
    ...(typeof metadata.solUsdPerToken === 'string' && Number.isFinite(Number(metadata.solUsdPerToken))
      ? { solUsdPerToken: Number(metadata.solUsdPerToken) }
      : {}),
    ...(isStringField(metadata.priceSource) ? { solPriceSource: metadata.priceSource } : {}),
    ...(isStringField(metadata.priceCheckedAt) ? { solPriceCheckedAt: metadata.priceCheckedAt } : {}),
  };
}

function draftTotal(draft: PayOutDraft): number {
  return draft.lineItems.reduce((sum, item) => {
    const quantity = Number(item.quantity || '0');
    const unitAmount = Number(item.unitAmount || '0');
    return Number.isFinite(quantity) && Number.isFinite(unitAmount) ? sum + quantity * unitAmount : sum;
  }, 0);
}

function buildCartTextFromDraft(draft: PayOutDraft): string {
  const merchantName = draft.merchantName.trim();
  if (!merchantName) throw new Error('Merchant name is required.');
  const recipient = draft.recipient.trim();
  if (!recipient) throw new Error('Recipient wallet is required.');
  const paymentToken = draft.paymentToken.trim().toUpperCase() || 'USDC';
  const lineItems = draft.lineItems.flatMap((item, index) => {
    const name = item.name.trim();
    const quantityText = item.quantity.trim();
    const unitAmount = item.unitAmount.trim();
    if (!name && !quantityText && !unitAmount) return [];
    if (!name) throw new Error(`Line item ${index + 1} needs a name.`);
    if (!quantityText) throw new Error(`Line item ${index + 1} needs a quantity.`);
    if (!unitAmount) throw new Error(`Line item ${index + 1} needs an amount.`);
    const quantity = Number(quantityText);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Line item ${index + 1} quantity must be a positive whole number.`);
    }
    if (!DECIMAL_AMOUNT_REGEX.test(unitAmount)) {
      throw new Error(`Line item ${index + 1} amount must be a decimal value.`);
    }
    return [{
      id: `item_${String(index + 1).padStart(3, '0')}`,
      name,
      quantity,
      unitAmount,
      currency: 'USD',
    }];
  });
  if (lineItems.length === 0) throw new Error('Add at least one line item.');
  const total = lineItems.reduce((sum, item) => sum + Number(item.unitAmount) * Number(item.quantity), 0);
  const cart = {
    id: `cart_${Date.now().toString(36)}`,
    cartVersion: '1',
    merchant: {
      id: `merchant_${slugId(merchantName, 'custom')}`,
      name: merchantName,
      recipient,
    },
    lineItems,
    totalAmount: formatMoney(total),
    currency: 'USD',
    paymentToken,
    cluster: DEFAULT_ACP_CLUSTER,
    ...(draft.memo.trim() ? { memo: draft.memo.trim() } : {}),
  };
  return JSON.stringify(cart, null, 2);
}

function formatFiat(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `USD ${value.toFixed(2)}`;
  }
  if (isStringField(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return `USD ${parsed.toFixed(2)}`;
    return value;
  }
  return '';
}

// Server returns { preview: { cart, transfer, totalFiat, resolvedTokenMint } }
// where cart matches `AcpCart` and transfer matches `AcpTransferParams`.
// See apps/render-web/src/cloud/acpRoutes.ts:106-113 and the contract test at
// apps/render-web/src/__tests__/acp-api.test.ts:331-345.
export function normalizePreview(input: unknown): AcpPreviewDisplay {
  if (!input || typeof input !== 'object') {
    throw new Error('Server returned an empty cart preview.');
  }
  const env = input as Record<string, unknown>;
  const cart = env.cart;
  const transfer = env.transfer;
  if (!cart || typeof cart !== 'object') throw new Error('Cart preview is missing the cart object.');
  if (!transfer || typeof transfer !== 'object') throw new Error('Cart preview is missing the transfer object.');

  const cartRec = cart as Record<string, unknown>;
  const transferRec = transfer as Record<string, unknown>;
  const merchantRaw = (cartRec.merchant && typeof cartRec.merchant === 'object'
    ? (cartRec.merchant as Record<string, unknown>)
    : {});

  const merchantName = isStringField(merchantRaw.name) ? merchantRaw.name : 'Unknown merchant';
  const merchantRecipient = isStringField(merchantRaw.recipient) ? merchantRaw.recipient : '';

  const lineItemsRaw = Array.isArray(cartRec.lineItems) ? cartRec.lineItems : [];
  const lineItems: AcpLineItemDisplay[] = [];
  for (const item of lineItemsRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = isStringField(row.name) ? row.name : '';
    const unitAmount = isStringField(row.unitAmount) ? row.unitAmount : '';
    if (!name || !unitAmount) continue;
    const quantityRaw = row.quantity;
    const quantity = typeof quantityRaw === 'number' && Number.isFinite(quantityRaw)
      ? quantityRaw
      : Number(quantityRaw ?? 1);
    lineItems.push({ name, unitAmount, quantity: Number.isFinite(quantity) ? quantity : 1 });
  }

  const cartId = isStringField(cartRec.id) ? cartRec.id : '';
  const cartVersion = isStringField(cartRec.cartVersion) ? cartRec.cartVersion : '1';
  const totalAmount = isStringField(cartRec.totalAmount) ? cartRec.totalAmount : '';
  const paymentToken = isStringField(cartRec.paymentToken) ? cartRec.paymentToken : 'USDC';
  const cluster = isStringField(cartRec.cluster) ? cartRec.cluster : 'mainnet-beta';
  const memo = isStringField(cartRec.memo) ? cartRec.memo : undefined;
  const resolvedTokenMint = isStringField(env.resolvedTokenMint) ? env.resolvedTokenMint : '';
  const transferRecipient = isStringField(transferRec.recipient) ? transferRec.recipient : merchantRecipient;
  const transferAmount = isStringField(transferRec.amount) ? transferRec.amount : totalAmount;

  if (!totalAmount || !transferRecipient) {
    throw new Error('Cart preview is missing totalAmount or transfer.recipient.');
  }

  const result: AcpPreviewDisplay = {
    cartId,
    cartVersion,
    merchant: { name: merchantName, recipient: merchantRecipient },
    lineItems,
    totalAmount,
    totalFiat: formatFiat(env.totalFiat),
    paymentToken,
    resolvedTokenMint,
    cluster,
    recipient: transferRecipient,
    transferAmount,
  };
  if (memo !== undefined) {
    result.memo = memo;
  }
  return result;
}

function requiredString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (!isStringField(value)) throw new Error(`${label} is required.`);
  return value;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return isStringField(value) ? value : undefined;
}

function normalizeAcpCluster(value: string): string {
  if (value === 'mainnet') return 'mainnet-beta';
  if (value === 'mainnet-beta' || value === 'devnet' || value === 'testnet' || value === 'localnet') return value;
  throw new Error('Cluster must be mainnet-beta, devnet, testnet, or localnet.');
}

function parseLocalLineItems(value: unknown): { items: JsonRecord[]; computedTotal: number } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Payment request must include at least one line item.');
  }
  let computedTotal = 0;
  const items = value.map((entry, index): JsonRecord => {
    if (!isObjectRecord(entry)) throw new Error(`Line item ${index + 1} must be an object.`);
    const id = requiredString(entry, 'id', `Line item ${index + 1} id`);
    const name = requiredString(entry, 'name', `Line item ${index + 1} name`);
    const quantity = entry.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Line item ${index + 1} quantity must be a positive whole number.`);
    }
    const unitAmount = requiredString(entry, 'unitAmount', `Line item ${index + 1} unit amount`);
    if (!DECIMAL_AMOUNT_REGEX.test(unitAmount)) {
      throw new Error(`Line item ${index + 1} unit amount must be a decimal string.`);
    }
    const currency = requiredString(entry, 'currency', `Line item ${index + 1} currency`);
    if (currency !== 'USD') throw new Error('Only USD payment requests are supported in this preview.');
    computedTotal += Number(unitAmount) * quantity;
    return { id, name, quantity, unitAmount, currency };
  });
  return { items, computedTotal };
}

function resolveLocalTokenMint(cart: JsonRecord, cluster: string, paymentToken: string): string {
  const explicitMint = optionalString(cart, 'paymentTokenMint');
  const defaultMint = LOCAL_TOKEN_MINTS[cluster]?.[paymentToken];
  if (explicitMint) {
    if (!SOLANA_ADDRESS_REGEX.test(explicitMint)) {
      throw new Error('paymentTokenMint must be a Solana token mint address.');
    }
    if (defaultMint && explicitMint !== defaultMint) {
      throw new Error(`paymentTokenMint does not match canonical ${paymentToken} on ${cluster}.`);
    }
    return explicitMint;
  }
  if (!defaultMint) {
    throw new Error(`${paymentToken} is not supported on ${cluster} without paymentTokenMint.`);
  }
  return defaultMint;
}

function buildLocalPreviewEnvelope(cartInput: unknown): JsonRecord {
  if (!isObjectRecord(cartInput)) throw new Error('Payment request must be a JSON object.');
  const cartId = requiredString(cartInput, 'id', 'Payment request id');
  const cartVersion = requiredString(cartInput, 'cartVersion', 'Payment request version');
  if (cartVersion !== '1') throw new Error('Only cartVersion 1 payment requests are supported.');
  if (!isObjectRecord(cartInput.merchant)) throw new Error('Merchant details are required.');
  const merchant = cartInput.merchant;
  const merchantId = requiredString(merchant, 'id', 'Merchant id');
  const merchantName = requiredString(merchant, 'name', 'Merchant name');
  const recipient = requiredString(merchant, 'recipient', 'Merchant recipient');
  if (!SOLANA_ADDRESS_REGEX.test(recipient)) {
    throw new Error('Merchant recipient must be a Solana wallet address.');
  }
  const { items, computedTotal } = parseLocalLineItems(cartInput.lineItems);
  const totalAmount = requiredString(cartInput, 'totalAmount', 'Total amount');
  if (!DECIMAL_AMOUNT_REGEX.test(totalAmount)) throw new Error('Total amount must be a decimal string.');
  const total = Number(totalAmount);
  if (!Number.isFinite(total) || total <= 0) throw new Error('Total amount must be greater than zero.');
  if (Math.abs(total - computedTotal) > LOCAL_TOTAL_TOLERANCE) {
    throw new Error(`Total amount (${total.toFixed(2)}) does not match line items (${computedTotal.toFixed(2)}).`);
  }
  const currency = requiredString(cartInput, 'currency', 'Currency');
  if (currency !== 'USD') throw new Error('Only USD payment requests are supported in this preview.');
  const paymentToken = requiredString(cartInput, 'paymentToken', 'Payment token');
  if (paymentToken !== 'USDC' && paymentToken !== 'USDT') {
    throw new Error('Payment token must be USDC or USDT.');
  }
  const cluster = normalizeAcpCluster(requiredString(cartInput, 'cluster', 'Cluster'));
  const resolvedTokenMint = resolveLocalTokenMint(cartInput, cluster, paymentToken);
  const expiresAt = optionalString(cartInput, 'expiresAt');
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) throw new Error('Expiration must be an ISO timestamp.');
    if (expiresMs <= Date.now()) throw new Error('This payment request is expired.');
  }
  const memo = optionalString(cartInput, 'memo');
  const paymentTokenMint = optionalString(cartInput, 'paymentTokenMint');
  const metadata = isObjectRecord(cartInput.metadata) ? cartInput.metadata : undefined;
  const cart: JsonRecord = {
    id: cartId,
    cartVersion,
    merchant: { id: merchantId, name: merchantName, recipient },
    lineItems: items,
    totalAmount,
    currency,
    paymentToken,
    ...(paymentTokenMint ? { paymentTokenMint } : {}),
    cluster,
    ...(expiresAt ? { expiresAt } : {}),
    ...(memo ? { memo } : {}),
    ...(metadata ? { metadata } : {}),
  };
  return {
    cart,
    transfer: {
      token: paymentToken,
      recipient,
      amount: totalAmount,
      note: memo ?? `ACP cart ${cartId}: ${merchantName}`,
    },
    totalFiat: Math.round(total * 100) / 100,
    resolvedTokenMint,
  };
}

export function previewCartLocally(cart: unknown): FetchResult<AcpPreviewDisplay> {
  try {
    return { kind: 'ok', value: normalizePreview(buildLocalPreviewEnvelope(cart)) };
  } catch (err) {
    return { kind: 'badRequest', message: err instanceof Error ? err.message : String(err) };
  }
}

export function renderPayOutPanel(): string {
  const errorBlock = panelState.error ? errorBanner(panelState.error) : '';
  const noticeBlock = panelState.notice
    ? noticeBanner(panelState.notice.title, panelState.notice.body)
    : '';
  const body =
    panelState.phase === 'preview' && panelState.preview
      ? previewView(panelState.preview, panelState.busy)
      : composeView(panelState.cartText, panelState.busy);

  return `
    <section class="pay-out-panel dev-tab-shell" data-pay-out-root>
      <header class="pay-out-header dev-tab-header">
        <div class="dev-tab-header-main">
          <p class="dev-tab-kicker">Agentic Commerce Protocol</p>
          <div class="dev-tab-title-row">
            <h2>Pay Out</h2>
            <span class="pay-out-mode">Manual approval</span>
          </div>
          <p>Review a payment request, then send it to Needs Approval. Your wallet signs later; this screen never transfers automatically.</p>
          <div class="pay-out-capability-row" aria-label="Pay Out safeguards">
            <span class="dev-tab-pill">Readable request review</span>
            <span class="dev-tab-pill">Request validation</span>
            <span class="dev-tab-pill">Wallet approval required</span>
          </div>
        </div>
        <div class="pay-out-route-card terminal-preview-window" aria-label="Payment route">
          <div class="terminal-preview-bar pay-out-route-bar">
            <span></span>
            <span></span>
            <span></span>
            <strong>acp-route</strong>
          </div>
          <div class="pay-out-route-body">
            <div>
              <span>Request</span>
              <strong>Merchant or agent</strong>
            </div>
            <div>
              <span>Review</span>
              <strong>Human-readable details</strong>
            </div>
            <div>
              <span>Approval</span>
              <strong>Needs Approval</strong>
            </div>
          </div>
        </div>
      </header>
      ${noticeBlock}
      ${errorBlock}
      ${body}
    </section>
  `;
}

function composeView(cartText: string, busy: boolean): string {
  const disabled = busy ? 'disabled' : '';
  const hasRequest = cartText.trim().length > 0;
  const entryMode = panelState.entryMode;
  const draft = panelState.draft ?? cartDraftFromText(cartText);
  return `
    <form class="pay-out-form dev-tab-panel" data-pay-out-form onsubmit="return false;">
      <div class="pay-out-form-head">
        <div>
          <span class="pay-out-section-label">Payment request</span>
          <h3>Create a payment request</h3>
          <p>Type the payment details, review the human-readable summary, then send it to Needs Approval.</p>
        </div>
        ${entryModeTabs(entryMode)}
      </div>
      <section class="pay-out-entry-card" aria-label="Create payment request">
        ${entryMode === 'json' ? advancedJsonPanel(cartText, disabled) : manualRequestPanel(draft, disabled)}
      </section>
      <div class="pay-out-request-layout pay-out-sample-layout">
        ${demoRequestPanel(disabled)}
      </div>
      <div class="pay-out-actions">
        <span class="pay-out-action-note">${hasRequest ? 'Loaded request values are editable above.' : 'No developer JSON required for normal use.'}</span>
        <div class="pay-out-actions-end">
          ${hasRequest ? `<button type="button" class="pay-out-button secondary" data-pay-out-action="clear" ${disabled}>Clear request</button>` : ''}
        </div>
      </div>
      ${busy ? '<p class="pay-out-busy" data-pay-out-busy>Working…</p>' : ''}
    </form>
  `;
}

function entryModeTabs(entryMode: EntryMode): string {
  const tab = (mode: EntryMode, label: string) => `
    <button
      type="button"
      class="${entryMode === mode ? 'active' : ''}"
      role="tab"
      aria-selected="${entryMode === mode ? 'true' : 'false'}"
      data-pay-out-action="entry-${mode}"
    >
      ${escapeHtml(label)}
    </button>
  `;
  return `
    <div class="pay-out-entry-tabs" role="tablist" aria-label="Payment request entry mode">
      ${tab('details', 'Type payment details')}
      ${tab('json', 'Paste JSON request')}
    </div>
  `;
}

function manualRequestPanel(draft: PayOutDraft, disabled: string): string {
  const total = draftTotal(draft);
  const lineRows = draft.lineItems.map((item, index) => lineItemDraftRow(item, index, disabled)).join('');
  const tokenOptions = ['USDC', 'USDT'].map((token) =>
    `<option value="${token}" ${draft.paymentToken.toUpperCase() === token ? 'selected' : ''}>${token}</option>`,
  ).join('');
  return `
    <section class="pay-out-manual-request" data-pay-out-builder role="tabpanel" aria-label="Payment details">
      <div class="pay-out-builder-head">
        <div>
          <span class="pay-out-request-status">Normal entry</span>
          <h4>Payment details</h4>
        </div>
        <div class="pay-out-builder-total" aria-label="Current calculated total">
          <span>Total</span>
          <strong>${escapeHtml(formatMoney(total))} ${escapeHtml(draft.paymentToken.toUpperCase() || 'USDC')}</strong>
        </div>
      </div>
      <div class="pay-out-field-grid">
        <label>
          <span>Merchant name</span>
          <input class="pay-out-input" name="merchantName" value="${escapeHtml(draft.merchantName)}" placeholder="Acme Coffee" ${disabled}>
        </label>
        <label>
          <span>Recipient wallet</span>
          <input class="pay-out-input" name="recipient" value="${escapeHtml(draft.recipient)}" placeholder="Merchant Solana address" ${disabled}>
        </label>
        <label>
          <span>Token</span>
          <select class="pay-out-input" name="paymentToken" ${disabled}>${tokenOptions}</select>
        </label>
        <label>
          <span>Memo</span>
          <input class="pay-out-input" name="memo" value="${escapeHtml(draft.memo)}" placeholder="Invoice, order, or note" ${disabled}>
        </label>
      </div>
      <div class="pay-out-line-editor">
        <div class="pay-out-line-editor-head">
          <span>Line items</span>
          <em>Quantity x unit amount becomes the total</em>
        </div>
        <div class="pay-out-line-grid" role="group" aria-label="Line items">
          ${lineRows}
        </div>
      </div>
      <div class="pay-out-actions">
        <span class="pay-out-action-note">Validation runs before anything reaches Needs Approval.</span>
        <div class="pay-out-actions-end">
          <button type="button" class="pay-out-button" data-pay-out-action="preview" ${disabled}>Review payment request</button>
        </div>
      </div>
    </section>
  `;
}

function lineItemDraftRow(item: PayOutLineDraft, index: number, disabled: string): string {
  const row = index + 1;
  return `
    <div class="pay-out-line-row" data-pay-out-line-item>
      <label>
        <span>Item ${row}</span>
        <input class="pay-out-input" name="lineName" value="${escapeHtml(item.name)}" placeholder="${row === 1 ? 'Latte' : 'Optional item'}" ${disabled}>
      </label>
      <label>
        <span>Qty</span>
        <input class="pay-out-input" name="lineQuantity" inputmode="numeric" value="${escapeHtml(item.quantity)}" placeholder="1" ${disabled}>
      </label>
      <label>
        <span>Unit amount</span>
        <input class="pay-out-input" name="lineUnitAmount" inputmode="decimal" value="${escapeHtml(item.unitAmount)}" placeholder="0.00" ${disabled}>
      </label>
    </div>
  `;
}

function advancedJsonPanel(cartText: string, disabled: string): string {
  return `
    <section class="pay-out-import-request pay-out-advanced-json" role="tabpanel" aria-label="Paste JSON request">
      <div class="pay-out-import-head">
        <div>
          <span class="pay-out-request-status">Developer import</span>
          <h4>Paste JSON request</h4>
        </div>
        <button type="button" class="pay-out-button secondary" data-pay-out-action="paste-clipboard" ${disabled}>Paste from clipboard</button>
      </div>
      <div class="pay-out-editor-shell terminal-preview-window">
        <div class="terminal-preview-bar pay-out-editor-bar">
          <span></span>
          <span></span>
          <span></span>
          <strong>request.json</strong>
        </div>
        <textarea
          id="pay-out-cart-input"
          class="pay-out-cart-input"
          name="cart"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          placeholder='{"id":"cart_...","lineItems":[...],"totalAmount":"17.80","paymentToken":"USDC"}'
          ${disabled}
        >${escapeHtml(cartText)}</textarea>
      </div>
      <div class="pay-out-actions">
        <span class="pay-out-action-note">Use this only for checkout, QR, or external-agent payloads.</span>
        <div class="pay-out-actions-end">
          <button type="button" class="pay-out-button secondary" data-pay-out-action="preview-json" ${disabled}>Review raw JSON</button>
        </div>
      </div>
    </section>
  `;
}

function demoRequestPanel(disabled: string): string {
  return `
    <section class="pay-out-demo-request" aria-label="Demo payment request">
      <span class="pay-out-request-status">Sample request</span>
      <div class="pay-out-request-title-row">
        <h4>Acme Coffee</h4>
        <strong>17.80 USDC</strong>
      </div>
      <p>Latte x2, Croissant, Tax</p>
      <dl class="pay-out-request-mini-grid">
        <div>
          <dt>Source</dt>
          <dd>Checkout</dd>
        </div>
        <div>
          <dt>Approval</dt>
          <dd>Manual</dd>
        </div>
      </dl>
      <button type="button" class="pay-out-button secondary" data-pay-out-action="load-sample" ${disabled}>Load sample request</button>
    </section>
  `;
}

function previewView(preview: AcpPreviewDisplay, busy: boolean): string {
  const disabled = busy ? 'disabled' : '';
  const totalFiat = preview.totalFiat ? `<span>${escapeHtml(preview.totalFiat)}</span>` : '';
  const lineRows = preview.lineItems
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.name)}${
            item.quantity > 1 ? ` <span aria-hidden="true">× ${item.quantity}</span>` : ''
          }</td>
          <td class="amount">${escapeHtml(item.unitAmount)}</td>
        </tr>
      `,
    )
    .join('');

  const mintHint = preview.resolvedTokenMint
    ? `<span class="muted" title="${escapeHtml(preview.resolvedTokenMint)}">(${escapeHtml(shortAddress(preview.resolvedTokenMint))})</span>`
    : '';
  const fiatHint = preview.totalFiat
    ? `<span class="pay-out-fiat-hint">${escapeHtml(preview.totalFiat)}</span>`
    : '';
  const memoRow = preview.memo
    ? `<dt>Memo</dt><dd>${escapeHtml(preview.memo)}</dd>`
    : '';
  const merchantWalletHint = preview.merchant.recipient
    ? `<span class="muted" title="${escapeHtml(preview.merchant.recipient)}">(${escapeHtml(shortAddress(preview.merchant.recipient))})</span>`
    : '';

  return `
    <div class="pay-out-preview terminal-preview-window" data-pay-out-preview>
      <div class="terminal-preview-bar pay-out-preview-bar">
        <span></span>
        <span></span>
        <span></span>
        <strong>approval-preview</strong>
      </div>
      <div class="pay-out-preview-body">
        <div class="pay-out-preview-head">
          <div>
            <span>Merchant</span>
            <strong>${escapeHtml(preview.merchant.name)}</strong>
          </div>
          <div class="pay-out-preview-total">
            <span>Total</span>
            <strong>${escapeHtml(preview.totalAmount)} ${escapeHtml(preview.paymentToken)}</strong>
            ${totalFiat}
          </div>
        </div>

        <dl class="pay-out-meta">
          <div>
            <dt>Merchant</dt>
            <dd>${escapeHtml(preview.merchant.name)} ${merchantWalletHint}</dd>
          </div>
          <div>
            <dt>Recipient</dt>
            <dd title="${escapeHtml(preview.recipient)}">${escapeHtml(shortAddress(preview.recipient))}</dd>
          </div>
          <div>
            <dt>Pay with</dt>
            <dd>${escapeHtml(preview.paymentToken)} ${mintHint}</dd>
          </div>
          ${memoRow ? `<div>${memoRow}</div>` : ''}
        </dl>

        <table class="pay-out-line-items" aria-label="Line items">
          <thead>
            <tr><th scope="col">Item</th><th scope="col" class="amount">Unit amount</th></tr>
          </thead>
          <tbody>${lineRows}</tbody>
        </table>

        <div class="pay-out-total">
          <span class="label">Total</span>
          <span>
            <span aria-hidden="true">${escapeHtml(preview.paymentToken)} </span>${escapeHtml(preview.totalAmount)}
            ${fiatHint}
          </span>
        </div>

        <p class="pay-out-disclaimer">Confirming sends this request to Needs Approval. No transfer happens until your wallet approves it.</p>

        <div class="pay-out-actions">
          <button type="button" class="pay-out-button secondary" data-pay-out-action="edit" ${disabled}>Change request</button>
          <div class="pay-out-actions-end">
            <button type="button" class="pay-out-button" data-pay-out-action="confirm" ${disabled}>Send to Needs Approval</button>
          </div>
        </div>
        ${busy ? '<p class="pay-out-busy" data-pay-out-busy>Creating approval…</p>' : ''}
      </div>
    </div>
  `;
}

function errorBanner(message: string): string {
  return `
    <div class="pay-out-error" role="alert" data-pay-out-error>
      <div><strong>Couldn't continue</strong>${escapeHtml(message)}</div>
      <button type="button" class="dismiss" aria-label="Dismiss" data-pay-out-action="dismiss-error">×</button>
    </div>
  `;
}

function noticeBanner(title: string, body: string): string {
  return `
    <div class="pay-out-notice" role="status" data-pay-out-notice>
      <div><strong>${escapeHtml(title)}</strong>${escapeHtml(body)}</div>
      <button type="button" class="dismiss" aria-label="Dismiss" data-pay-out-action="dismiss-notice">×</button>
    </div>
  `;
}

type FetchResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'badRequest'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'notDeployed' }
  | { kind: 'error'; message: string };

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string; message?: string; path?: string };
    return body.message ?? body.detail ?? body.error ?? fallback;
  } catch {
    return fallback;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<FetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message: `Network error: ${message}` };
  }
  if (res.status === 404) return { kind: 'notDeployed' };
  if (res.status === 403) return { kind: 'forbidden' };
  if (res.status === 400) {
    return { kind: 'badRequest', message: await extractErrorMessage(res, 'Cart was rejected by the server.') };
  }
  if (!res.ok) {
    return { kind: 'error', message: await extractErrorMessage(res, `Request failed (${res.status})`) };
  }
  try {
    const data = (await res.json()) as T;
    return { kind: 'ok', value: data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message: `Bad JSON response: ${message}` };
  }
}

export async function previewCart(cart: unknown): Promise<FetchResult<AcpPreviewDisplay>> {
  const result = await postJson<{ preview?: unknown }>('/api/acp/cart/preview', { cart });
  if (result.kind !== 'ok') return result;
  try {
    const preview = normalizePreview(result.value.preview);
    return { kind: 'ok', value: preview };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
  }
}

// Server returns { approval: ApprovalRequestRecord, cartId, cartHash }
// (see apps/render-web/src/cloud/acpRoutes.ts:190-194 and the contract test
// at apps/render-web/src/__tests__/acp-api.test.ts:410-436).
export async function approveCart(cart: unknown): Promise<FetchResult<ApprovalCreated>> {
  const result = await postJson<{
    approval?: { id?: unknown } | null;
    cartId?: unknown;
    cartHash?: unknown;
    localOnly?: unknown;
  }>('/api/acp/cart/approve', {
    cart,
    walletAddress: getConnectedAddress(),
  });
  if (result.kind !== 'ok') return result;
  const approvalIdRaw = result.value.approval && typeof result.value.approval === 'object'
    ? (result.value.approval as { id?: unknown }).id
    : undefined;
  const cartIdRaw = result.value.cartId;
  if (!isStringField(approvalIdRaw) || !isStringField(cartIdRaw)) {
    return { kind: 'error', message: 'Server did not return approval.id and cartId.' };
  }
  const created: ApprovalCreated = { cartId: cartIdRaw, approvalId: approvalIdRaw };
  const cartHashRaw = result.value.cartHash;
  if (isStringField(cartHashRaw)) {
    created.cartHash = cartHashRaw;
  }
  if (result.value.approval && typeof result.value.approval === 'object') {
    created.approval = result.value.approval;
  }
  if (result.value.localOnly === true) {
    created.localOnly = true;
  }
  return { kind: 'ok', value: created };
}

function randomLocalApprovalId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(8);
    cryptoApi.getRandomValues(bytes);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `browser-acp_${hex}`;
  }
  return `browser-acp_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}

function cartRecordForLocalApproval(cart: unknown, preview: AcpPreviewDisplay): JsonRecord {
  if (isObjectRecord(cart)) return cart;
  return {
    id: preview.cartId,
    cartVersion: preview.cartVersion,
    merchant: preview.merchant,
    lineItems: preview.lineItems.map((item, index) => ({
      id: `line_${index + 1}`,
      name: item.name,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      currency: 'USD',
    })),
    totalAmount: preview.totalAmount,
    currency: 'USD',
    paymentToken: preview.paymentToken,
    ...(preview.resolvedTokenMint ? { paymentTokenMint: preview.resolvedTokenMint } : {}),
    cluster: preview.cluster,
    ...(preview.memo ? { memo: preview.memo } : {}),
  };
}

export function approveCartLocally(cart: unknown, preview: AcpPreviewDisplay): FetchResult<ApprovalCreated> {
  const walletAddress = getConnectedAddress();
  if (!walletAddress) {
    return { kind: 'badRequest', message: 'Connect a wallet before sending the payment request to Needs Approval.' };
  }
  const cartRecord = cartRecordForLocalApproval(cart, preview);
  const cartId = isStringField(cartRecord.id) ? cartRecord.id : preview.cartId;
  if (!cartId) return { kind: 'badRequest', message: 'Payment request is missing an id.' };
  const now = new Date().toISOString();
  const dueAt = optionalString(cartRecord, 'expiresAt') ?? now;
  const merchant = isObjectRecord(cartRecord.merchant) ? cartRecord.merchant : preview.merchant;
  const approvalId = randomLocalApprovalId();
  const params: JsonRecord = {
    recipient: preview.recipient,
    token: preview.paymentToken,
    amount: preview.transferAmount,
    ...(preview.resolvedTokenMint ? { tokenMint: preview.resolvedTokenMint } : {}),
    ...(preview.memo ? { memo: preview.memo } : {}),
  };
  const approval: JsonRecord = {
    id: approvalId,
    walletAddress,
    kind: 'transfer_spl',
    status: 'ready',
    summary: `ACP: ${preview.merchant.name} - ${preview.totalAmount} ${preview.paymentToken}`,
    params,
    cluster: preview.cluster,
    dueAt,
    createdAt: now,
    updatedAt: now,
    amount: preview.transferAmount,
    token: preview.paymentToken,
    recipient: preview.recipient,
    note: preview.memo ?? `ACP cart ${cartId}: ${preview.merchant.name}`,
    metadata: {
      source: 'acp_outbound',
      actionSource: 'acp_outbound',
      acpCartId: cartId,
      acpCart: cartRecord,
      merchant,
      totalAmount: preview.totalAmount,
      paymentToken: preview.paymentToken,
      resolvedTokenMint: preview.resolvedTokenMint,
      acpCluster: preview.cluster,
      totalFiat: preview.totalFiat,
      receivedAt: now,
      devLocal: true,
    },
  };
  return {
    kind: 'ok',
    value: {
      cartId,
      approvalId,
      approval,
      localOnly: true,
    },
  };
}

function browserLocalNotice(): NoticeInfo {
  return {
    title: 'Using browser-local approvals',
    body: 'This dev server has no ACP API route, so the approval will be saved in this browser under Needs Approval.',
  };
}

function forbiddenNotice(): NoticeInfo {
  return {
    title: 'Dev gate active',
    body: 'Connect the allowed dev wallet and sign in to Agentic Cloud to use Pay Out.',
  };
}

function rerenderPanelOnly(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('[data-pay-out-root]');
  if (!root || !root.parentNode) return;
  const template = document.createElement('template');
  template.innerHTML = renderPayOutPanel().trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  root.replaceWith(next);
}

let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  if (typeof document === 'undefined') return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'pay-out-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.remove('visible');
  }, 3_000);
}

function clickInboxTab(): boolean {
  if (typeof document === 'undefined') return false;
  const button = document.querySelector<HTMLButtonElement>('button[data-tab="inbox"]');
  if (!button) return false;
  button.click();
  return true;
}

function readCartTextarea(): string {
  if (typeof document === 'undefined') return panelState.cartText;
  const textarea = document.getElementById('pay-out-cart-input') as HTMLTextAreaElement | null;
  return textarea ? textarea.value : panelState.cartText;
}

function readBuilderCartText(): string {
  if (typeof document === 'undefined') return panelState.cartText;
  const draft = readBuilderDraftFromDom();
  if (!draft) return panelState.cartText;
  panelState.draft = draft;
  return buildCartTextFromDraft(draft);
}

function readBuilderDraftFromDom(): PayOutDraft | null {
  if (typeof document === 'undefined') return null;
  const root = document.querySelector<HTMLElement>('[data-pay-out-builder]');
  if (!root) return null;
  const input = (name: string): string =>
    root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? '';
  const lineItems = Array.from(root.querySelectorAll<HTMLElement>('[data-pay-out-line-item]')).map((row) => ({
    name: row.querySelector<HTMLInputElement>('[name="lineName"]')?.value ?? '',
    quantity: row.querySelector<HTMLInputElement>('[name="lineQuantity"]')?.value ?? '',
    unitAmount: row.querySelector<HTMLInputElement>('[name="lineUnitAmount"]')?.value ?? '',
  }));
  return {
    merchantName: input('merchantName'),
    recipient: input('recipient'),
    paymentToken: input('paymentToken'),
    memo: input('memo'),
    lineItems,
  };
}

async function pasteRequestFromClipboard(): Promise<void> {
  if (panelState.busy) return;
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
    panelState.error = 'Clipboard paste is unavailable in this browser. Paste the request into the text box.';
    rerenderPanelOnly();
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      panelState.error = 'Clipboard is empty.';
      rerenderPanelOnly();
      return;
    }
    panelState.cartText = text;
    panelState.draft = null;
    panelState.entryMode = 'json';
    panelState.error = '';
    panelState.notice = null;
    panelState.phase = 'compose';
    panelState.preview = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panelState.error = `Clipboard paste failed: ${message}`;
  }
  rerenderPanelOnly();
}

function rememberBuilderDraft(): void {
  const draft = readBuilderDraftFromDom();
  if (draft) panelState.draft = draft;
}

export async function handleAction(action: string): Promise<void> {
  switch (action) {
    case 'entry-details':
      rememberBuilderDraft();
      panelState.entryMode = 'details';
      rerenderPanelOnly();
      return;
    case 'entry-json':
      rememberBuilderDraft();
      panelState.entryMode = 'json';
      rerenderPanelOnly();
      return;
    case 'load-sample':
      panelState.error = '';
      panelState.notice = null;
      panelState.phase = 'compose';
      panelState.entryMode = 'details';
      panelState.cartText = '';
      panelState.draft = null;
      try {
        panelState.cartText = sampleCartForRecipient(getConnectedAddress() ?? '');
      } catch (err) {
        panelState.error = err instanceof Error ? err.message : String(err);
      }
      rerenderPanelOnly();
      return;
    case 'clear':
      panelState.cartText = '';
      panelState.error = '';
      panelState.notice = null;
      panelState.phase = 'compose';
      panelState.entryMode = 'details';
      panelState.draft = null;
      panelState.preview = null;
      rerenderPanelOnly();
      return;
    case 'edit':
      panelState.phase = 'compose';
      panelState.entryMode = 'details';
      rerenderPanelOnly();
      return;
    case 'dismiss-error':
      panelState.error = '';
      rerenderPanelOnly();
      return;
    case 'dismiss-notice':
      panelState.notice = null;
      rerenderPanelOnly();
      return;
    case 'paste-clipboard':
      await pasteRequestFromClipboard();
      return;
    case 'preview':
      await runPreview('form');
      return;
    case 'preview-json':
      await runPreview('json');
      return;
    case 'confirm':
      await runConfirm();
      return;
    default:
      return;
  }
}

async function runPreview(source: 'form' | 'json'): Promise<void> {
  if (panelState.busy) return;
  panelState.error = '';
  panelState.notice = null;
  let parsed: unknown;
  try {
    panelState.cartText = source === 'json' ? readCartTextarea() : readBuilderCartText();
    if (source === 'json') panelState.draft = null;
    parsed = parseCartText(panelState.cartText);
  } catch (err) {
    panelState.error = err instanceof Error ? err.message : String(err);
    rerenderPanelOnly();
    return;
  }
  panelState.busy = true;
  rerenderPanelOnly();
  let result = await previewCart(parsed);
  let usingLocalFallback = false;
  if (result.kind === 'notDeployed') {
    result = previewCartLocally(parsed);
    usingLocalFallback = result.kind === 'ok';
  }
  panelState.busy = false;
  if (result.kind === 'ok') {
    panelState.preview = result.value;
    panelState.phase = 'preview';
    if (source === 'form') panelState.draft = cartDraftFromText(panelState.cartText);
    if (usingLocalFallback) {
      panelState.notice = browserLocalNotice();
    }
  } else if (result.kind === 'badRequest') {
    panelState.error = result.message;
  } else if (result.kind === 'forbidden') {
    panelState.notice = forbiddenNotice();
  } else if (result.kind === 'notDeployed') {
    panelState.notice = browserLocalNotice();
  } else {
    panelState.error = result.message;
  }
  rerenderPanelOnly();
}

async function runConfirm(): Promise<void> {
  if (panelState.busy) return;
  const preview = panelState.preview;
  if (!preview) return;
  panelState.busy = true;
  panelState.error = '';
  rerenderPanelOnly();
  const cart = panelState.cartText ? safeJsonParse(panelState.cartText) : null;
  let result = await approveCart(cart ?? {});
  if (result.kind === 'notDeployed') {
    result = approveCartLocally(cart ?? {}, preview);
  }
  panelState.busy = false;
  if (result.kind === 'ok') {
    showToast(`Approval ready · ${shortAddress(result.value.approvalId)} — review in Needs Approval`);
    const dispatched = dispatchPayOutApprovalCreated({
      source: 'acp_outbound',
      approvalId: result.value.approvalId,
      cartId: result.value.cartId,
      ...(result.value.cartHash ? { cartHash: result.value.cartHash } : {}),
      ...(result.value.approval ? { approval: result.value.approval } : {}),
      ...(result.value.localOnly ? { localOnly: true } : {}),
    });
    panelState.phase = 'compose';
    panelState.entryMode = 'details';
    panelState.cartText = '';
    panelState.draft = null;
    panelState.preview = null;
    panelState.error = '';
    panelState.notice = null;
    rerenderPanelOnly();
    if (!dispatched) clickInboxTab();
    return;
  }
  if (result.kind === 'badRequest') {
    panelState.error = result.message;
  } else if (result.kind === 'forbidden') {
    panelState.notice = forbiddenNotice();
  } else if (result.kind === 'notDeployed') {
    panelState.notice = browserLocalNotice();
  } else {
    panelState.error = result.message;
  }
  rerenderPanelOnly();
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const trigger = target.closest<HTMLElement>('[data-pay-out-action]');
    if (!trigger) return;
    const action = trigger.dataset.payOutAction;
    if (!action) return;
    event.preventDefault();
    void handleAction(action);
  });
}
