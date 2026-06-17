import { renderApprovalBadges } from '../approvalBadges.js';
import { currentAddress, refreshConnection } from '../connectionState.js';
import { dispatchAp2InboundDemoCreated } from '../ap2InboundDemoEvents.js';
import { getConnectedAddress, getConnectedCluster } from '../walletState.js';
import { MppApiError, getMppInbound, postMppChallenge, postMppSessionPay } from '../mppClient.js';
import { listStreamingSessions } from '../streamingClient.js';
import { renderUseCaseDisclosure } from './useCases.js';
import { t, tf } from '../demo-i18n/uiLang.js';
import './externalAgents.css';

// Mirrors the server's normalizeApprovalForResponse() at
// apps/render-web/src/cloud/ap2Routes.ts:401-418 and the metadata enrichment
// at lines 209-216 (which adds `publicKey` to `ap2VerifiedAgent`).
export interface NormalizedApproval {
  id: string;
  kind: string;
  status: string;
  summary: string;
  amount: string | null;
  token: string | null;
  recipient: string | null;
  cluster: string | null;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  txid: string | null;
  txStatus: string | null;
  metadata: NormalizedApprovalMetadata;
  params: Record<string, unknown>;
}

export interface NormalizedApprovalMetadata {
  ap2VerifiedAgent?: { agentId: string; agentLabel: string; publicKey?: string; verified?: boolean };
  ap2MandateId?: string;
  ap2MandateType?: string;
  ap2ProtocolVersion?: string;
  connectorId?: string;
  connectorName?: string;
  mppSessionEligibility?: MppSessionEligibility;
  mppSessionPayment?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CacheState = 'idle' | 'loading' | 'loaded' | 'error';

export interface MppSessionEligibility {
  eligible?: boolean;
  finality?: 'voucher_accepted' | 'settlement_confirmed';
  reason?: string;
  reasonCode?: string;
  session?: MppSessionCandidate;
  sessions?: MppSessionCandidate[];
  paymentMethod?: Record<string, unknown>;
  warnings?: MppSessionWarning[];
  policy?: Record<string, unknown>;
}

export interface MppSessionCandidate {
  sessionId?: string;
  remaining?: string;
  expiresAt?: string;
  capAmount?: string;
  spentAmount?: string;
  cluster?: string;
  tokenMint?: string;
  capConsumptionBps?: number;
  warnings?: MppSessionWarning[];
  recipientAllowlist?: string[];
  [key: string]: unknown;
}

export interface MppSessionWarning {
  code?: string;
  message?: string;
  thresholdBps?: number;
  capConsumptionBps?: number;
  amount?: string;
  remaining?: string;
  [key: string]: unknown;
}

interface TabState {
  status: CacheState;
  inbound: NormalizedApproval[];
  errorMessage: string;
  lastFetchedFor: string | null;
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'denied',
  'cancelled',
  'expired',
  'rejected',
]);

const state: TabState = {
  status: 'idle',
  inbound: [],
  errorMessage: '',
  lastFetchedFor: null,
};

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEMO_AMOUNT = '2.00';
const MPP_DEMO_AMOUNT = '0.50';
const mppSessionPaying = new Set<string>();
const mppSelectedSessionByApproval = new Map<string, string>();
const mppSessionPaymentErrors = new Map<string, string>();
const mppSessionPaymentSuccess = new Map<string, string>();

function randomBrowserAp2Id(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(8);
    cryptoApi.getRandomValues(bytes);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `browser-ap2_${hex}`;
  }
  return `browser-ap2_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}

function randomBrowserMppNonce(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(8);
    cryptoApi.getRandomValues(bytes);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `browser_mpp_${hex}`;
  }
  return `browser_mpp_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}

async function demoMppPaymentTarget(walletAddress: string, fallbackCluster: string): Promise<{
  cluster: string;
  recipient: string;
}> {
  const sessions = await listStreamingSessions('active').catch(() => []);
  const matching = sessions.find((session) =>
    session.status === 'active' &&
    session.tokenMint === USDC_MINT &&
    session.walletAddress === walletAddress &&
    session.metadata?.signerRuntime !== 'android-native' &&
    session.metadata?.signerRuntime !== 'ios-native',
  );
  if (!matching) return { cluster: fallbackCluster, recipient: walletAddress };
  const recipient = matching.recipientAllowlist?.find((entry) => entry && typeof entry === 'string') ?? walletAddress;
  return { cluster: matching.cluster, recipient };
}

// ---------------- Pure helpers (exported for tests) ----------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function shortAddress(value: string): string {
  if (!value) return '';
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

export function formatRelative(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso || '';
  const deltaMs = now - parsed;
  if (deltaMs < 0) return t('in the future');
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return tf('{minutes}m ago', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tf('{hours}h ago', { hours });
  const days = Math.floor(hours / 24);
  return tf('{days}d ago', { days });
}

export function sortInbound(items: NormalizedApproval[]): NormalizedApproval[] {
  return [...items].sort((left, right) => {
    const leftTerminal = TERMINAL_STATUSES.has(left.status) ? 1 : 0;
    const rightTerminal = TERMINAL_STATUSES.has(right.status) ? 1 : 0;
    if (leftTerminal !== rightTerminal) return leftTerminal - rightTerminal;
    return (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
  });
}

function isLocalDemoInbound(item: NormalizedApproval): boolean {
  return item.id.startsWith('browser-ap2_') || item.metadata?.demoLocal === true;
}

function mergeInboundWithLocalDemos(inbound: NormalizedApproval[]): NormalizedApproval[] {
  const inboundIds = new Set(inbound.map((item) => item.id));
  const localDemos = state.inbound.filter((item) => isLocalDemoInbound(item) && !inboundIds.has(item.id));
  return sortInbound([...localDemos, ...inbound]);
}

function statusPillClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'ready' || normalized === 'pending') return 'pending';
  if (normalized === 'approved') return 'approved';
  if (TERMINAL_STATUSES.has(normalized)) return 'terminated';
  if (normalized === 'failed') return 'terminated';
  return 'neutral';
}

function isMppApproval(item: NormalizedApproval): boolean {
  return item.metadata?.connectorId === 'mpp' || item.metadata?.actionSource === 'mpp_challenge';
}

function mppEligibility(item: NormalizedApproval): MppSessionEligibility | undefined {
  const value = item.metadata?.mppSessionEligibility;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MppSessionEligibility
    : undefined;
}

function mppEligibleSessions(eligibility: MppSessionEligibility | undefined): MppSessionCandidate[] {
  if (!eligibility) return [];
  const sessions = Array.isArray(eligibility.sessions) ? eligibility.sessions : [];
  if (sessions.length > 0) return sessions.filter((session) => session && typeof session === 'object');
  return eligibility.session ? [eligibility.session] : [];
}

function selectedMppSession(
  eligibility: MppSessionEligibility | undefined,
  approvalId?: string,
): MppSessionCandidate | undefined {
  const sessions = mppEligibleSessions(eligibility);
  const selectedId = approvalId ? mppSelectedSessionByApproval.get(approvalId) : undefined;
  if (selectedId) {
    const selected = sessions.find((session) => session.sessionId === selectedId);
    if (selected) return selected;
  }
  return sessions[0] ?? eligibility?.session;
}

function mppWarnings(eligibility: MppSessionEligibility | undefined, session?: MppSessionCandidate): MppSessionWarning[] {
  const warnings = [
    ...(Array.isArray(eligibility?.warnings) ? eligibility!.warnings! : []),
    ...(Array.isArray(session?.warnings) ? session!.warnings! : []),
  ];
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code ?? ''}:${warning.capConsumptionBps ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatFinality(value: string | undefined): string {
  if (value === 'settlement_confirmed') return t('settlement required');
  if (value === 'voucher_accepted') return t('voucher accepted');
  return value ? t(value.replace(/_/g, ' ')) : t('voucher accepted');
}

function formatExpiry(iso: string | undefined): string {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(parsed));
}

function mppSessionOptionLabel(session: MppSessionCandidate): string {
  const id = session.sessionId ? shortAddress(session.sessionId) : t('session');
  const remaining = session.remaining ? tf('{remaining} left', { remaining: session.remaining }) : t('cap available');
  const expiry = session.expiresAt ? tf('exp {expiry}', { expiry: formatExpiry(session.expiresAt) }) : t('no expiry');
  return `${id} · ${remaining} · ${expiry}`;
}

function agentLabelForItem(item: NormalizedApproval): string {
  const agent = item.metadata?.ap2VerifiedAgent;
  const ap2Label = agent?.agentLabel?.trim() || agent?.agentId?.trim();
  if (ap2Label) return ap2Label;
  const challenge = item.metadata?.mppChallenge;
  if (challenge && typeof challenge === 'object' && !Array.isArray(challenge)) {
    const merchant = (challenge as Record<string, unknown>).merchant;
    if (merchant && typeof merchant === 'object' && !Array.isArray(merchant)) {
      const merchantRecord = merchant as Record<string, unknown>;
      const merchantName = typeof merchantRecord.name === 'string' ? merchantRecord.name.trim() : '';
      const merchantId = typeof merchantRecord.id === 'string' ? merchantRecord.id.trim() : '';
      if (merchantName || merchantId) return merchantName || merchantId;
    }
  }
  return item.metadata?.connectorName && typeof item.metadata.connectorName === 'string'
    ? item.metadata.connectorName
    : t('unknown agent');
}

function mppSessionHint(item: NormalizedApproval): string {
  if (!isMppApproval(item)) return '';
  const payment = item.metadata?.mppSessionPayment;
  if (payment && typeof payment === 'object' && !Array.isArray(payment)) {
    const status = typeof (payment as Record<string, unknown>).status === 'string'
      ? (payment as Record<string, unknown>).status as string
      : 'paid';
    return `<span class="external-agents-row-session paid">${tf('Session {status}', { status: escapeHtml(t(status.replace(/_/g, ' '))) })}</span>`;
  }
  const eligibility = mppEligibility(item);
  if (eligibility?.eligible) {
    const session = selectedMppSession(eligibility, item.id);
    const remaining = session?.remaining ? tf(' · {remaining} left', { remaining: session.remaining }) : '';
    const finality = ` · ${formatFinality(eligibility.finality)}`;
    return `<span class="external-agents-row-session ready">${t('Session ready')}${escapeHtml(remaining + finality)}</span>`;
  }
  if (eligibility?.reasonCode) {
    return `<span class="external-agents-row-session unavailable" title="${escapeHtml(eligibility.reason ?? '')}">${t('No session match')}</span>`;
  }
  return '';
}

function mppSessionDetailHtml(item: NormalizedApproval): string {
  if (!isMppApproval(item)) return '';
  const eligibility = mppEligibility(item);
  const session = selectedMppSession(eligibility, item.id);
  const paymentMethod = eligibility?.paymentMethod ?? {};
  const recipient = typeof paymentMethod.recipient === 'string'
    ? paymentMethod.recipient
    : item.recipient ?? '';
  if (!eligibility?.eligible || !session) {
    if (!eligibility?.reason) return '';
    return `<div class="external-agents-row-session-detail unavailable">${escapeHtml(eligibility.reason)}</div>`;
  }
  const warnings = mppWarnings(eligibility, session);
  const warningHtml = warnings.map((warning) => {
    const bps = typeof warning.capConsumptionBps === 'number' ? Math.round(warning.capConsumptionBps / 100) : undefined;
    const label = bps !== undefined ? tf('Uses {bps}% of remaining cap', { bps }) : (warning.message ?? t('Session warning'));
    return `<span class="external-agents-session-warning" title="${escapeHtml(warning.message ?? label)}">${escapeHtml(label)}</span>`;
  }).join('');
  const policy = eligibility.policy;
  const policyFinality = policy?.requireSettlementConfirmed === true ? t('strict') : t('standard');
  return `
    <div class="external-agents-row-session-detail">
      <span>${tf('Cap {remaining} left', { remaining: escapeHtml(session.remaining ?? t('unknown')) })}</span>
      <span>${tf('Expires {expiry}', { expiry: escapeHtml(formatExpiry(session.expiresAt) || t('unknown')) })}</span>
      <span>${tf('Recipient {recipient}', { recipient: escapeHtml(shortAddress(recipient)) })}</span>
      <span>${tf('Finality {finality}', { finality: escapeHtml(formatFinality(eligibility.finality)) })}</span>
      <span>${tf('Policy {policy}', { policy: escapeHtml(policyFinality) })}</span>
      ${warningHtml}
    </div>
  `;
}

function mppSessionSelectorHtml(item: NormalizedApproval): string {
  const eligibility = mppEligibility(item);
  const sessions = mppEligibleSessions(eligibility);
  if (!eligibility?.eligible || sessions.length <= 1) return '';
  const selected = selectedMppSession(eligibility, item.id);
  return `
    <label class="external-agents-session-select">
      <span>${t('Session')}</span>
      <select data-mpp-session-select="${escapeHtml(item.id)}" aria-label="${escapeHtml(t('MPP streaming session'))}">
        ${sessions.map((session) => `
          <option value="${escapeHtml(session.sessionId ?? '')}"${selected?.sessionId === session.sessionId ? ' selected' : ''}>${escapeHtml(mppSessionOptionLabel(session))}</option>
        `).join('')}
      </select>
    </label>
  `;
}

function mppSessionRowMessageHtml(item: NormalizedApproval): string {
  const error = mppSessionPaymentErrors.get(item.id);
  if (error) {
    return `<p class="external-agents-row-session-message error">${escapeHtml(error)}</p>`;
  }
  const success = mppSessionPaymentSuccess.get(item.id);
  if (success) {
    return `<p class="external-agents-row-session-message success">${escapeHtml(success)}</p>`;
  }
  const payment = item.metadata?.mppSessionPayment;
  if (payment && typeof payment === 'object' && !Array.isArray(payment)) {
    const status = typeof (payment as Record<string, unknown>).status === 'string'
      ? (payment as Record<string, unknown>).status
      : '';
    if (status === 'settlement_pending') {
      return `<p class="external-agents-row-session-message info">${t('Voucher accepted. Settlement confirmation will finalize from Sessions.')}</p>`;
    }
  }
  return '';
}

// ---------------- Renderers (exported for tests) ----------------

export function rowHtml(item: NormalizedApproval): string {
  const rawAgentLabel = agentLabelForItem(item);
  const agentLabel = escapeHtml(rawAgentLabel);
  const avatarLabel = escapeHtml((rawAgentLabel.slice(0, 1) || 'A').toUpperCase());
  const amountText =
    item.amount && item.token
      ? `${escapeHtml(item.amount)} ${escapeHtml(item.token)}`
      : item.amount
        ? escapeHtml(item.amount)
        : '—';
  const recipientHtml = item.recipient
    ? `<span class="external-agents-row-recipient">${tf('to {recipient}', { recipient: escapeHtml(shortAddress(item.recipient)) })}</span>`
    : '';
  const clusterHtml = item.cluster
    ? `<span class="external-agents-row-cluster">${escapeHtml(item.cluster)}</span>`
    : '';
  const terminal = TERMINAL_STATUSES.has(item.status);
  const mpp = isMppApproval(item);
  const eligibility = mppEligibility(item);
  const paying = mppSessionPaying.has(item.id);
  const canPayWithSession = mpp && !terminal && eligibility?.eligible === true;
  const buttonLabel = terminal ? t('Open in Inbox') : t('Review and pay');
  const sessionButton = canPayWithSession
    ? `<button type="button" class="primary" data-mpp-session-pay="${escapeHtml(item.id)}"${paying ? ' disabled' : ''}>${paying ? t('Paying…') : t('Pay with Session')}</button>`
    : '';
  const sessionSelector = canPayWithSession ? mppSessionSelectorHtml(item) : '';
  return `
    <li class="external-agents-row${terminal ? ' terminal' : ''}" data-inbound-id="${escapeHtml(item.id)}">
      <span class="external-agents-row-avatar" aria-hidden="true">${avatarLabel}</span>
      <div class="external-agents-row-main">
        <div class="external-agents-row-head">
          <strong class="external-agents-row-agent">${agentLabel}</strong>
          <span class="external-agents-row-status status-pill ${escapeHtml(statusPillClass(item.status))}">${escapeHtml(item.status)}</span>
          ${renderApprovalBadges(item)}
          <span class="external-agents-row-time" title="${escapeHtml(item.createdAt)}">${escapeHtml(formatRelative(item.createdAt))}</span>
        </div>
        <p class="external-agents-row-summary">${escapeHtml(item.summary)}</p>
        <div class="external-agents-row-meta">
          <span class="external-agents-row-amount">${amountText}</span>
          ${recipientHtml}
          <span class="external-agents-row-kind">${escapeHtml(t(item.kind.replace(/_/g, ' ')))}</span>
          ${clusterHtml}
          ${mppSessionHint(item)}
        </div>
        ${mppSessionDetailHtml(item)}
        ${mppSessionRowMessageHtml(item)}
      </div>
      <div class="external-agents-row-actions">
        ${sessionSelector}
        ${sessionButton}
        <button type="button" class="primary" data-tab="inbox" data-external-agents-open="${escapeHtml(item.id)}">${buttonLabel}</button>
      </div>
    </li>
  `;
}

export function bodyHtml(snapshot: TabState = state): string {
  switch (snapshot.status) {
    case 'idle':
    case 'loading':
      return `<p class="external-agents-loading dev-tab-loading-state">${t('Loading inbound mandates…')}</p>`;
    case 'error':
      return `
        <div class="external-agents-error">
          <p>${tf('Could not load inbound agent payment requests: {error}', { error: escapeHtml(snapshot.errorMessage || t('unknown error')) })}</p>
          <button type="button" class="utility" data-external-agents-retry>${t('Retry')}</button>
        </div>
      `;
    case 'loaded':
      if (snapshot.inbound.length === 0) {
        return `
          <div class="external-agents-empty dev-tab-empty-state">
            <p>${t('No inbound agent payment requests yet. AP2 mandates and MPP challenges appear here before payment.')}</p>
            <div class="external-agents-empty-actions">
              <button type="button" class="primary" data-external-agents-demo>${t('Create AP2 request')}</button>
              <button type="button" class="utility" data-external-agents-mpp-demo>${t('Create MPP challenge')}</button>
            </div>
          </div>
        `;
      }
      return `
        ${snapshot.errorMessage ? `<div class="external-agents-inline-error">${escapeHtml(snapshot.errorMessage)}</div>` : ''}
        <ol class="external-agents-list">${sortInbound(snapshot.inbound).map(rowHtml).join('')}</ol>
      `;
  }
}

export function createDemoInboundRequest(walletAddress: string, cluster = 'mainnet-beta'): NormalizedApproval {
  const id = randomBrowserAp2Id();
  const now = new Date();
  const createdAt = now.toISOString();
  const dueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const mandateId = `demo_mandate_${id.replace(/^browser-ap2_/, '')}`;
  const memo = 'AP2 demo request: Acme Coffee';
  const cart = {
    merchantName: 'Acme Coffee',
    lineItems: [
      { name: 'Latte', quantity: 2, unitAmount: '0.80', currency: 'USD' },
      { name: 'Croissant', quantity: 1, unitAmount: '0.30', currency: 'USD' },
      { name: 'Tax', quantity: 1, unitAmount: '0.10', currency: 'USD' },
    ],
    totalAmount: DEMO_AMOUNT,
    paymentToken: 'USDC',
    requesterWallet: walletAddress,
  };
  return {
    id,
    kind: 'transfer_spl',
    status: 'ready',
    summary: `AP2 inbound: Acme Coffee requests ${DEMO_AMOUNT} USDC to ${shortAddress(walletAddress)}`,
    amount: DEMO_AMOUNT,
    token: 'USDC',
    recipient: walletAddress,
    cluster,
    dueAt,
    createdAt,
    updatedAt: createdAt,
    txid: null,
    txStatus: null,
    metadata: {
      connectorId: 'ap2',
      connectorName: 'Google AP2',
      capability: 'inbound_payment',
      operation: 'inbound_payment',
      source: 'ap2_inbound',
      actionSource: 'ap2_inbound',
      approvalBoundary: 'per_run',
      demoLocal: true,
      ap2MandateId: mandateId,
      ap2MandateType: 'payment_mandate',
      ap2ProtocolVersion: 'ap2/0.1',
      ap2VerifiedAgent: {
        agentId: 'agent:demo.acme-coffee',
        agentLabel: 'Acme Coffee',
        publicKey: 'local-demo-request',
        verified: true,
      },
      ap2DemoCart: cart,
      actionProposal: {
        protocolVersion: 'ap2/0.1',
        mandateId,
        mandateType: 'payment_mandate',
        payment: {
          amount: DEMO_AMOUNT,
          tokenSymbol: 'USDC',
          tokenMint: USDC_MINT,
          recipient: walletAddress,
          cluster,
          memo,
        },
      },
    },
    params: {
      fromAddress: walletAddress,
      toAddress: walletAddress,
      recipient: walletAddress,
      amount: DEMO_AMOUNT,
      token: 'USDC',
      tokenMint: USDC_MINT,
      tokenSymbol: 'USDC',
      memo,
    },
  };
}

function createAndDispatchDemoRequest(): void {
  const walletAddress = getConnectedAddress() ?? currentAddress();
  if (!walletAddress) {
    state.status = 'error';
    state.errorMessage = t('Connect a wallet before creating a demo request.');
    patchPanel();
    return;
  }
  const demo = createDemoInboundRequest(walletAddress, getConnectedCluster() ?? 'mainnet-beta');
  state.status = 'loaded';
  state.errorMessage = '';
  state.lastFetchedFor = walletAddress;
  state.inbound = sortInbound([demo, ...state.inbound.filter((item) => item.id !== demo.id)]);
  dispatchAp2InboundDemoCreated({
    source: 'ap2_inbound_demo',
    approvalId: demo.id,
    approval: {
      id: demo.id,
      walletAddress,
      kind: demo.kind,
      status: demo.status,
      summary: demo.summary,
      amount: demo.amount ?? DEMO_AMOUNT,
      token: demo.token ?? 'USDC',
      recipient: demo.recipient ?? walletAddress,
      cluster: demo.cluster ?? 'mainnet-beta',
      params: demo.params,
      metadata: demo.metadata,
      dueAt: demo.dueAt,
      createdAt: demo.createdAt,
      updatedAt: demo.updatedAt,
      note: 'Demo AP2 inbound request from Acme Coffee.',
    },
  });
  patchPanel();
}

export async function createAndDispatchMppDemoChallenge(): Promise<void> {
  const walletAddress = getConnectedAddress() ?? currentAddress();
  if (!walletAddress) {
    state.status = 'error';
    state.errorMessage = t('Connect a wallet before creating an MPP demo challenge.');
    patchPanel();
    return;
  }
  const target = await demoMppPaymentTarget(walletAddress, getConnectedCluster() ?? 'devnet');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const challenge = {
    protocolVersion: 'mpp/0.1',
    nonce: randomBrowserMppNonce(),
    amount: MPP_DEMO_AMOUNT,
    currency: 'USDC',
    resourceUrl: 'https://merchant.example/demo/mpp',
    expiresAt,
    paymentMethods: [
      { kind: 'solana-spl', mint: USDC_MINT, recipient: target.recipient, network: target.cluster },
    ],
    merchant: { id: 'merchant_demo_mpp', name: 'MPP Demo Merchant', url: 'https://merchant.example' },
  };
  try {
    const result = await postMppChallenge({
      challenge,
      cluster: target.cluster,
      agentLabel: 'MPP Demo Merchant',
    });
    state.status = 'loaded';
    state.errorMessage = '';
    state.lastFetchedFor = walletAddress;
    if (isNormalizedApproval(result.approval)) {
      state.inbound = sortInbound([
        result.approval as NormalizedApproval,
        ...state.inbound.filter((item) => item.id !== result.approvalId),
      ]);
      patchPanel();
      return;
    }
    await fetchInbound(true);
  } catch (err) {
    state.status = state.inbound.length ? 'loaded' : 'error';
    state.errorMessage = err instanceof Error ? err.message : t('Could not create MPP demo challenge.');
    patchPanel();
  }
}

// ---------------- DOM patcher ----------------

function patchPanel(): void {
  if (typeof document === 'undefined') return;
  const body = document.getElementById('external-agents-body');
  if (body) {
    body.setAttribute('aria-busy', String(state.status === 'loading'));
    body.innerHTML = bodyHtml();
  }
  const refresh = document.querySelector<HTMLButtonElement>('[data-external-agents-refresh]');
  if (refresh) {
    refresh.disabled = state.status === 'loading';
    refresh.textContent = state.status === 'loading' ? t('Refreshing…') : t('Refresh');
  }
}

// ---------------- Async fetch ----------------

interface InboundFetchResult {
  items: NormalizedApproval[];
  errorMessage?: string;
}

async function fetchAp2InboundSource(): Promise<InboundFetchResult> {
  const res = await fetch('/api/ap2/inbound', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return { items: [] };
  if (res.status === 403) return { items: [], errorMessage: t('This wallet cannot view AP2 mandates on this deployment.') };
  if (res.status === 401) return { items: [], errorMessage: t('Sign into Agentic Cloud to view AP2 mandates.') };
  if (!res.ok) return { items: [], errorMessage: tf('HTTP {status}', { status: res.status }) };
  const payload = (await res.json().catch(() => null)) as
    | { inbound?: NormalizedApproval[]; items?: NormalizedApproval[] }
    | null;
  return { items: approvalsFromPayload(payload) };
}

async function fetchMppInboundSource(): Promise<InboundFetchResult> {
  try {
    const payload = await getMppInbound();
    return { items: approvalsFromPayload(payload) };
  } catch (err) {
    if (err instanceof MppApiError && (err.status === 404 || err.status === 403 || err.status === 401)) {
      return { items: [] };
    }
    if (err instanceof MppApiError && err.status !== undefined && err.status >= 500) {
      return { items: [], errorMessage: err.message };
    }
    return { items: [] };
  }
}

function approvalsFromPayload(payload: unknown): NormalizedApproval[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as { inbound?: unknown; items?: unknown };
  const source = Array.isArray(record.inbound)
    ? record.inbound
    : Array.isArray(record.items)
      ? record.items
      : [];
  return source.filter(isNormalizedApproval) as NormalizedApproval[];
}

function isNormalizedApproval(value: unknown): value is NormalizedApproval {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).id === 'string'
    && typeof (value as Record<string, unknown>).status === 'string'
    && typeof (value as Record<string, unknown>).summary === 'string';
}

export async function fetchInbound(force = false): Promise<void> {
  // Synchronous re-entrancy guard: mutate state before any await so the
  // second call in the same tick sees `loading` and returns early.
  if (state.status === 'loading' && !force) return;
  state.status = 'loading';
  state.errorMessage = '';
  patchPanel();
  await refreshConnection();
  const addr = currentAddress();
  if (!addr) {
    // Connection went away while we were resolving the session — clear the
    // loading state so the panel doesn't get stuck.
    state.status = 'idle';
    state.lastFetchedFor = null;
    patchPanel();
    return;
  }
  state.lastFetchedFor = addr;
  patchPanel();
  try {
    const [ap2, mpp] = await Promise.all([fetchAp2InboundSource(), fetchMppInboundSource()]);
    state.inbound = mergeInboundWithLocalDemos([...ap2.items, ...mpp.items]);
    state.errorMessage = [ap2.errorMessage, mpp.errorMessage].filter(Boolean).join(' ');
    state.status = state.inbound.length || !state.errorMessage ? 'loaded' : 'error';
  } catch (err) {
    state.inbound = mergeInboundWithLocalDemos([]);
    state.errorMessage = err instanceof Error ? err.message : t('Network error');
    state.status = state.inbound.length ? 'loaded' : 'error';
  }
  patchPanel();
}

// ---------------- Tab guard + render ----------------

function guard(): boolean {
  const addr = currentAddress();
  if (addr !== state.lastFetchedFor && state.status !== 'loading') {
    state.status = 'idle';
    state.inbound = [];
    state.errorMessage = '';
  }
  return true;
}

export function renderExternalAgentsPanel(): string {
  if (state.status === 'idle') {
    queueMicrotask(() => {
      void fetchInbound();
    });
  }
  const refreshing = state.status === 'loading';
  const activeCount = state.inbound.filter((item) => !TERMINAL_STATUSES.has(item.status)).length;
  const terminalCount = state.inbound.length - activeCount;
  return `
    <section class="external-agents-panel dev-tab-shell" data-layout="external-agents-panel">
      <header class="external-agents-header dev-tab-header">
        <div class="dev-tab-header-main">
          <p class="dev-tab-kicker">${t('Agent payment requests')}</p>
          <div class="dev-tab-title-row">
            <h2>${t('External Agents')}</h2>
            <span class="external-agents-live-pill">${refreshing ? t('Syncing') : t('Live queue')}</span>
          </div>
          <p>${t('AP2 mandates and MPP challenges sent by external agents land here before payment.')}</p>
        </div>
        <div class="dev-tab-header-actions">
          <button type="button" class="primary" data-external-agents-demo>${t('Create AP2 request')}</button>
          <button type="button" class="utility" data-external-agents-mpp-demo>${t('Create MPP challenge')}</button>
          <button type="button" class="utility" data-external-agents-refresh${refreshing ? ' disabled' : ''}>${refreshing ? t('Refreshing…') : t('Refresh')}</button>
        </div>
      </header>
      ${renderUseCaseDisclosure({
        id: 'agent-payments-incoming-requests',
        summary: t('When another verified agent asks this wallet to approve a payment.'),
        useCases: [
          {
            title: t('An external agent sends a bill'),
            body: t('A hotel, delivery, marketplace, or assistant agent sends an AP2 mandate or MPP payment challenge to your wallet instead of asking for a manual transfer.'),
          },
          {
            title: t('Use a bounded session when eligible'),
            body: t('MPP requests can spend from an active streaming session, issuing a voucher immediately while keeping the wallet cap, expiry, and recipient checks intact.'),
          },
          {
            title: t('Keep automated requests auditable'),
            body: t('Each mandate keeps its source, amount, recipient, and status visible before you decide whether it belongs in Needs Approval.'),
          },
        ],
      })}
      <div class="external-agents-overview" aria-label="${escapeHtml(t('External agent queue summary'))}">
        <div class="dev-tab-stat"><span>${t('Active')}</span><strong>${activeCount}</strong></div>
        <div class="dev-tab-stat"><span>${t('Completed')}</span><strong>${terminalCount}</strong></div>
        <div class="dev-tab-stat"><span>${t('Source')}</span><strong>AP2 + MPP</strong></div>
      </div>
      <section id="external-agents-body" class="external-agents-body" aria-label="${escapeHtml(t('Inbound agent payment requests'))}" aria-busy="${refreshing}">
        ${bodyHtml()}
      </section>
    </section>
  `;
}

// ---------------- Deep-link scroll + click delegation ----------------

function scrollToInboxApproval(approvalId: string): void {
  if (!approvalId || typeof document === 'undefined') return;
  // Two RAFs let main.ts's data-tab="inbox" handler finish its re-render
  // first, then we scroll the now-mounted approval card into view.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const selector = `[data-action-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(approvalId) : approvalId.replace(/"/g, '\\"')}"]`;
      const anchor = document.querySelector(selector);
      const article = anchor?.closest('article');
      if (article instanceof HTMLElement) {
        article.scrollIntoView({ behavior: 'smooth', block: 'center' });
        article.classList.add('external-agents-flash');
        window.setTimeout(() => article.classList.remove('external-agents-flash'), 1600);
      }
    }),
  );
}

async function payWithMppSession(approvalId: string, sessionId?: string): Promise<void> {
  if (!approvalId || mppSessionPaying.has(approvalId)) return;
  mppSessionPaying.add(approvalId);
  mppSessionPaymentErrors.delete(approvalId);
  mppSessionPaymentSuccess.delete(approvalId);
  patchPanel();
  try {
    const result = await postMppSessionPay({ approvalId, ...(sessionId ? { sessionId } : {}) });
    if (isNormalizedApproval(result.approval)) {
      state.inbound = sortInbound(state.inbound.map((item) => item.id === approvalId ? result.approval as NormalizedApproval : item));
    } else {
      await fetchInbound(true);
    }
    state.status = 'loaded';
    state.errorMessage = '';
    mppSessionPaymentSuccess.set(approvalId, result.status
      ? tf('Session payment {status}.', { status: t(result.status.replace(/_/g, ' ')) })
      : t('Session payment accepted.'));
  } catch (err) {
    state.status = state.inbound.length ? 'loaded' : 'error';
    const message = err instanceof Error ? err.message : t('Could not pay MPP request with session.');
    if (state.inbound.length) {
      state.errorMessage = '';
      mppSessionPaymentErrors.set(approvalId, message);
    } else {
      state.errorMessage = message;
    }
  } finally {
    mppSessionPaying.delete(approvalId);
    patchPanel();
  }
}

function installPanelClickHandler(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const refreshBtn = target.closest<HTMLButtonElement>('[data-external-agents-refresh]');
    if (refreshBtn) {
      event.preventDefault();
      state.status = 'idle';
      void fetchInbound(true);
      return;
    }
    const retryBtn = target.closest<HTMLButtonElement>('[data-external-agents-retry]');
    if (retryBtn) {
      event.preventDefault();
      state.status = 'idle';
      void fetchInbound(true);
      return;
    }
    const demoBtn = target.closest<HTMLButtonElement>('[data-external-agents-demo]');
    if (demoBtn) {
      event.preventDefault();
      createAndDispatchDemoRequest();
      return;
    }
    const mppDemoBtn = target.closest<HTMLButtonElement>('[data-external-agents-mpp-demo]');
    if (mppDemoBtn) {
      event.preventDefault();
      void createAndDispatchMppDemoChallenge();
      return;
    }
    const sessionPayBtn = target.closest<HTMLButtonElement>('[data-mpp-session-pay]');
    if (sessionPayBtn) {
      event.preventDefault();
      const approvalId = sessionPayBtn.getAttribute('data-mpp-session-pay') ?? '';
      const row = sessionPayBtn.closest<HTMLElement>('[data-inbound-id]');
      const select = row?.querySelector<HTMLSelectElement>('[data-mpp-session-select]');
      void payWithMppSession(approvalId, select?.value || undefined);
      return;
    }
    const openBtn = target.closest<HTMLElement>('[data-external-agents-open]');
    if (openBtn) {
      const approvalId = openBtn.getAttribute('data-external-agents-open') ?? '';
      // data-tab="inbox" on the same button lets main.ts switch the active
      // tab; we just queue the scroll for after its re-render.
      scrollToInboxApproval(approvalId);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.status === 'error' || (state.status === 'loaded' && state.inbound.length === 0)) {
      state.status = 'idle';
    }
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const approvalId = target.getAttribute('data-mpp-session-select');
    if (!approvalId) return;
    mppSelectedSessionByApproval.set(approvalId, target.value);
    mppSessionPaymentErrors.delete(approvalId);
    mppSessionPaymentSuccess.delete(approvalId);
    patchPanel();
  });
}

installPanelClickHandler();

// ---------------- Test-only surface ----------------

export const __externalAgentsForTests = {
  getState: (): Readonly<TabState> => state,
  resetState(next?: Partial<TabState>): void {
    state.status = next?.status ?? 'idle';
    state.inbound = next?.inbound ?? [];
    state.errorMessage = next?.errorMessage ?? '';
    state.lastFetchedFor = next?.lastFetchedFor ?? null;
    mppSessionPaying.clear();
    mppSelectedSessionByApproval.clear();
    mppSessionPaymentErrors.clear();
    mppSessionPaymentSuccess.clear();
  },
  statusPillClass,
  bodyHtml,
  rowHtml,
  sortInbound,
  fetchInbound,
  createDemoInboundRequest,
  createAndDispatchDemoRequest,
  createAndDispatchMppDemoChallenge,
  setSelectedMppSession(approvalId: string, sessionId: string): void {
    mppSelectedSessionByApproval.set(approvalId, sessionId);
  },
  setMppSessionPaymentError(approvalId: string, message: string): void {
    mppSessionPaymentErrors.set(approvalId, message);
  },
};
