import './payOut.css';
import { currentAddress } from '../connectionState.js';
import { isDevWallet } from '../devGate.js';
import { registerDevTab } from '../devTabRegistry.js';

export interface AcpLineItem {
  label: string;
  quantity?: number;
  amount: string;
}

export interface AcpMerchantInfo {
  name?: string;
  wallet?: string;
}

export interface AcpPreview {
  cartId?: string;
  merchant: AcpMerchantInfo;
  recipient: string;
  tokenMint: string;
  tokenSymbol?: string;
  lineItems: AcpLineItem[];
  total: string;
  totalRaw?: string;
  memo?: string;
}

export interface ApprovalCreated {
  cartId: string;
  approvalId: string;
}

export type Phase = 'compose' | 'preview';

interface NoticeInfo {
  title: string;
  body: string;
}

export interface PanelState {
  phase: Phase;
  cartText: string;
  preview: AcpPreview | null;
  error: string;
  notice: NoticeInfo | null;
  busy: boolean;
}

export const SAMPLE_CART = JSON.stringify(
  {
    merchant: { name: 'Acme Coffee', wallet: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M' },
    recipient: '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M',
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenSymbol: 'USDC',
    lineItems: [
      { label: 'Latte', quantity: 2, amount: '12.00' },
      { label: 'Croissant', quantity: 1, amount: '4.50' },
      { label: 'Tax', amount: '1.30' },
    ],
    total: '17.80',
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

export function normalizePreview(input: unknown): AcpPreview {
  if (!input || typeof input !== 'object') {
    throw new Error('Server returned an empty cart preview.');
  }
  const raw = input as Record<string, unknown>;
  const merchantRaw = (raw.merchant && typeof raw.merchant === 'object' ? raw.merchant : {}) as Record<string, unknown>;
  const lineItemsRaw = Array.isArray(raw.lineItems) ? raw.lineItems : [];
  const lineItems: AcpLineItem[] = [];
  for (const item of lineItemsRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const label = isStringField(row.label) ? row.label : '';
    const amount = isStringField(row.amount) ? row.amount : '';
    if (!label || !amount) continue;
    const entry: AcpLineItem = { label, amount };
    if (typeof row.quantity === 'number' && Number.isFinite(row.quantity)) {
      entry.quantity = row.quantity;
    }
    lineItems.push(entry);
  }

  const recipient = isStringField(raw.recipient) ? raw.recipient : '';
  const tokenMint = isStringField(raw.tokenMint) ? raw.tokenMint : '';
  const total = isStringField(raw.total) ? raw.total : '';

  if (!recipient || !tokenMint || !total) {
    throw new Error('Cart preview is missing recipient, tokenMint, or total.');
  }

  return {
    cartId: isStringField(raw.cartId) ? raw.cartId : undefined,
    merchant: {
      name: isStringField(merchantRaw.name) ? merchantRaw.name : undefined,
      wallet: isStringField(merchantRaw.wallet) ? merchantRaw.wallet : undefined,
    },
    recipient,
    tokenMint,
    tokenSymbol: isStringField(raw.tokenSymbol) ? raw.tokenSymbol : undefined,
    lineItems,
    total,
    totalRaw: isStringField(raw.totalRaw) ? raw.totalRaw : undefined,
    memo: isStringField(raw.memo) ? raw.memo : undefined,
  };
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

function previewView(preview: AcpPreview, busy: boolean): string {
  const disabled = busy ? 'disabled' : '';
  const merchantName = preview.merchant.name ?? 'Unknown merchant';
  const merchantWallet = preview.merchant.wallet ?? '';
  const token = preview.tokenSymbol ?? 'token';
  const lineRows = preview.lineItems
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.label)}${
            typeof item.quantity === 'number' && item.quantity > 1
              ? ` <span aria-hidden="true">× ${item.quantity}</span>`
              : ''
          }</td>
          <td class="amount">${escapeHtml(item.amount)}</td>
        </tr>
      `,
    )
    .join('');

  return `
    <div class="pay-out-preview" data-pay-out-preview>
      <dl class="pay-out-meta">
        <dt>Merchant</dt>
        <dd>${escapeHtml(merchantName)}${
          merchantWallet
            ? ` <span class="muted">(${escapeHtml(shortAddress(merchantWallet))})</span>`
            : ''
        }</dd>
        <dt>Recipient</dt>
        <dd title="${escapeHtml(preview.recipient)}">${escapeHtml(shortAddress(preview.recipient))}</dd>
        <dt>Token</dt>
        <dd>${escapeHtml(token)}${
          preview.tokenMint
            ? ` <span class="muted" title="${escapeHtml(preview.tokenMint)}">(${escapeHtml(shortAddress(preview.tokenMint))})</span>`
            : ''
        }</dd>
        ${
          preview.memo
            ? `<dt>Memo</dt><dd>${escapeHtml(preview.memo)}</dd>`
            : ''
        }
      </dl>

      <table class="pay-out-line-items" aria-label="Line items">
        <thead>
          <tr><th scope="col">Item</th><th scope="col" class="amount">Amount</th></tr>
        </thead>
        <tbody>${lineRows}</tbody>
      </table>

      <div class="pay-out-total">
        <span class="label">Total</span>
        <span><span aria-hidden="true">${escapeHtml(token)} </span>${escapeHtml(preview.total)}</span>
      </div>

      <p class="pay-out-disclaimer">Confirming creates a single approval in Needs Approval. Your wallet signs the SPL transfer there — nothing is sent automatically.</p>

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
    const body = (await res.json()) as { error?: string; detail?: string; message?: string };
    return body.detail ?? body.error ?? body.message ?? fallback;
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

export async function previewCart(cart: unknown): Promise<FetchResult<AcpPreview>> {
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

export async function approveCart(cart: unknown): Promise<FetchResult<ApprovalCreated>> {
  const result = await postJson<{ cartId?: string; approvalId?: string }>('/api/acp/cart/approve', { cart });
  if (result.kind !== 'ok') return result;
  const { cartId, approvalId } = result.value;
  if (!isStringField(cartId) || !isStringField(approvalId)) {
    return { kind: 'error', message: 'Server did not return cartId + approvalId.' };
  }
  return { kind: 'ok', value: { cartId, approvalId } };
}

function notDeployedNotice(): NoticeInfo {
  return {
    title: 'ACP backend not deployed yet',
    body: '/api/acp/cart/preview returned 404. The Pay Out tab lights up once Agents 2 (packages/acp-adapter) and 6 (apps/render-web/src/cloud/acpRoutes.ts) ship.',
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
    showToast(`Sent to Needs Approval · ${shortAddress(result.value.approvalId)}`);
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
  guard: () => isDevWallet(currentAddress()),
  render: renderPayOutPanel,
});
