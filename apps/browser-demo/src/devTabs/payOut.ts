import './payOut.css';
import { isDevWallet } from '../devGate.js';
import { registerDevTab } from '../devTabRegistry.js';
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
}

export type Phase = 'compose' | 'preview';

interface NoticeInfo {
  title: string;
  body: string;
}

export interface PanelState {
  phase: Phase;
  cartText: string;
  preview: AcpPreviewDisplay | null;
  error: string;
  notice: NoticeInfo | null;
  busy: boolean;
}

// Sample cart that round-trips through `validateAcpCart`:
//   2 × $6.00 + 1 × $4.50 + 1 × $1.30 = $17.80 (matches totalAmount).
export const SAMPLE_CART = JSON.stringify(
  {
    id: 'cart_demo_001',
    cartVersion: '1',
    merchant: {
      id: 'merchant_acme_coffee',
      name: 'Acme Coffee',
      recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
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
  },
  null,
  2,
);

const panelState: PanelState = {
  phase: 'compose',
  cartText: '',
  preview: null,
  error: '',
  notice: null,
  busy: false,
};

export function __resetPanelStateForTests(next: Partial<PanelState> = {}): void {
  panelState.phase = next.phase ?? 'compose';
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
    throw new Error('Paste an ACP cart before previewing.');
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
    <section class="pay-out-panel" data-pay-out-root>
      <header class="pay-out-header">
        <h2>Pay Out</h2>
        <p>Settle an Agentic Commerce Protocol cart. Every payment routes through your wallet — nothing auto-pays.</p>
      </header>
      ${noticeBlock}
      ${errorBlock}
      ${body}
    </section>
  `;
}

function composeView(cartText: string, busy: boolean): string {
  const disabled = busy ? 'disabled' : '';
  return `
    <form class="pay-out-form" data-pay-out-form onsubmit="return false;">
      <label for="pay-out-cart-input">ACP cart</label>
      <textarea
        id="pay-out-cart-input"
        class="pay-out-cart-input"
        name="cart"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        ${disabled}
      >${escapeHtml(cartText)}</textarea>
      <div class="pay-out-actions">
        <button type="button" class="pay-out-button ghost" data-pay-out-action="load-sample" ${disabled}>Load sample</button>
        <div class="pay-out-actions-end">
          <button type="button" class="pay-out-button secondary" data-pay-out-action="clear" ${disabled}>Clear</button>
          <button type="button" class="pay-out-button" data-pay-out-action="preview" ${disabled}>Preview cart</button>
        </div>
      </div>
      ${busy ? '<p class="pay-out-busy" data-pay-out-busy>Working…</p>' : ''}
    </form>
  `;
}

function previewView(preview: AcpPreviewDisplay, busy: boolean): string {
  const disabled = busy ? 'disabled' : '';
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
    <div class="pay-out-preview" data-pay-out-preview>
      <dl class="pay-out-meta">
        <dt>Merchant</dt>
        <dd>${escapeHtml(preview.merchant.name)} ${merchantWalletHint}</dd>
        <dt>Recipient</dt>
        <dd title="${escapeHtml(preview.recipient)}">${escapeHtml(shortAddress(preview.recipient))}</dd>
        <dt>Pay with</dt>
        <dd>${escapeHtml(preview.paymentToken)} ${mintHint}</dd>
        <dt>Cluster</dt>
        <dd>${escapeHtml(preview.cluster)}</dd>
        ${memoRow}
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

      <p class="pay-out-disclaimer">Confirming creates an approval card in Needs Approval. The wallet you connect there signs the SPL transfer — nothing is sent automatically.</p>

      <div class="pay-out-actions">
        <button type="button" class="pay-out-button secondary" data-pay-out-action="edit" ${disabled}>← Edit cart</button>
        <div class="pay-out-actions-end">
          <button type="button" class="pay-out-button" data-pay-out-action="confirm" ${disabled}>Confirm payment</button>
        </div>
      </div>
      ${busy ? '<p class="pay-out-busy" data-pay-out-busy>Creating approval…</p>' : ''}
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
  }>('/api/acp/cart/approve', { cart });
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
  return { kind: 'ok', value: created };
}

function notDeployedNotice(): NoticeInfo {
  return {
    title: 'ACP backend not deployed yet',
    body: '/api/acp/cart/* returned 404. Server-side ACP routes are not live on this deployment.',
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

export async function handleAction(action: string): Promise<void> {
  switch (action) {
    case 'load-sample':
      panelState.cartText = SAMPLE_CART;
      panelState.error = '';
      panelState.notice = null;
      panelState.phase = 'compose';
      rerenderPanelOnly();
      return;
    case 'clear':
      panelState.cartText = '';
      panelState.error = '';
      panelState.notice = null;
      panelState.phase = 'compose';
      panelState.preview = null;
      rerenderPanelOnly();
      return;
    case 'edit':
      panelState.phase = 'compose';
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
    case 'preview':
      await runPreview();
      return;
    case 'confirm':
      await runConfirm();
      return;
    default:
      return;
  }
}

async function runPreview(): Promise<void> {
  if (panelState.busy) return;
  panelState.cartText = readCartTextarea();
  panelState.error = '';
  panelState.notice = null;
  let parsed: unknown;
  try {
    parsed = parseCartText(panelState.cartText);
  } catch (err) {
    panelState.error = err instanceof Error ? err.message : String(err);
    rerenderPanelOnly();
    return;
  }
  panelState.busy = true;
  rerenderPanelOnly();
  const result = await previewCart(parsed);
  panelState.busy = false;
  if (result.kind === 'ok') {
    panelState.preview = result.value;
    panelState.phase = 'preview';
  } else if (result.kind === 'badRequest') {
    panelState.error = result.message;
  } else if (result.kind === 'forbidden') {
    panelState.notice = forbiddenNotice();
  } else if (result.kind === 'notDeployed') {
    panelState.notice = notDeployedNotice();
  } else {
    panelState.error = result.message;
  }
  rerenderPanelOnly();
}

async function runConfirm(): Promise<void> {
  if (panelState.busy) return;
  if (!panelState.preview) return;
  panelState.busy = true;
  panelState.error = '';
  rerenderPanelOnly();
  const cart = panelState.cartText ? safeJsonParse(panelState.cartText) : null;
  const result = await approveCart(cart ?? {});
  panelState.busy = false;
  if (result.kind === 'ok') {
    showToast(`Approval ready · ${shortAddress(result.value.approvalId)} — sign in Needs Approval`);
    panelState.phase = 'compose';
    panelState.cartText = '';
    panelState.preview = null;
    panelState.error = '';
    panelState.notice = null;
    rerenderPanelOnly();
    clickInboxTab();
    return;
  }
  if (result.kind === 'badRequest') {
    panelState.error = result.message;
  } else if (result.kind === 'forbidden') {
    panelState.notice = forbiddenNotice();
  } else if (result.kind === 'notDeployed') {
    panelState.notice = notDeployedNotice();
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

registerDevTab({
  id: 'pay-out',
  label: 'Pay Out',
  mobileLabel: 'Pay',
  guard: () => isDevWallet(getConnectedAddress()),
  render: renderPayOutPanel,
});
