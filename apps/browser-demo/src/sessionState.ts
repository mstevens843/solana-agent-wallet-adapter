import type {
  StreamingSessionRecord,
  StreamingSettlementRecord,
  StreamingVoucherRecord,
  WorkflowCluster,
} from '@solana-agent-wallet-adapter/workflow';
import {
  createStreamingSession,
  getStreamingSession,
  listStreamingSessions,
  recordGrantSigned,
  recordRevokeSigned,
  revokeStreamingSession,
  StreamingApiError,
  submitStreamingVoucher,
  type CreateSessionRequestBody,
  type SubmitVoucherResponse,
  type StreamingSessionDetail,
} from './streamingClient.js';
import {
  callStreamingBridge,
  hasNativeStreamingBridge,
  nativeStreamingRuntime,
  type BridgeEnvelope,
} from './androidBridgeShim.js';
import {
  dispatchStreamingApprovalExecuteRequested,
  streamingApprovalSignedBody,
  type StreamingApprovalCompletedDetail,
  type StreamingApprovalOperation,
} from './streamingApprovalEvents.js';
import { getConnectedCluster } from './walletState.js';

export type SessionsStatusFilter = 'active' | 'expired' | 'settled' | 'revoked';
export type SessionsLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface StreamingSessionTxState {
  txid: string;
  status: 'submitted' | 'confirmed' | 'failed';
  txStatus?: string;
  approvalId?: string;
  updatedAt?: string;
}

export interface CreateSessionDraft {
  tokenMint: string;
  capAmount: string;
  durationMinutes: string;
  recipientAllowlist: string;
}

export interface SessionsNotice {
  tone: 'success' | 'error' | 'pending';
  message: string;
}

export interface SessionsState {
  status: SessionsLoadStatus;
  sessions: StreamingSessionRecord[];
  details: Record<string, StreamingSessionDetail>;
  selectedSessionId: string | null;
  filter: SessionsStatusFilter;
  errorMessage: string;
  busy: false | 'create' | 'revoke' | 'refresh';
  createModalOpen: boolean;
  createDraft: CreateSessionDraft;
  createErrors: Record<string, string>;
  voucherPage: number;
  lastFetchedAt: number;
  notice: SessionsNotice | null;
}

export const DEFAULT_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SESSIONS_DETAIL_POLL_MS = 5_000;
export const VOUCHERS_PER_PAGE = 8;
export const MAX_RECIPIENT_ALLOWLIST = 64;

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL_AMOUNT_REGEX = /^(?:(?:0|[1-9]\d*)(?:\.\d{1,6})?)$/;

const state: SessionsState = {
  status: 'idle',
  sessions: [],
  details: {},
  selectedSessionId: null,
  filter: 'active',
  errorMessage: '',
  busy: false,
  createModalOpen: false,
  createDraft: defaultCreateSessionDraft(),
  createErrors: {},
  voucherPage: 0,
  lastFetchedAt: 0,
  notice: null,
};

const listeners = new Set<() => void>();
let detailPollTimer: number | null = null;
let pollInFlight = false;

export function getSessionsState(): Readonly<SessionsState> {
  return state;
}

export function subscribeSessionsState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function defaultCreateSessionDraft(): CreateSessionDraft {
  return {
    tokenMint: DEFAULT_USDC_MINT,
    capAmount: '',
    durationMinutes: '60',
    recipientAllowlist: '',
  };
}

export function setSessionsFilter(filter: SessionsStatusFilter): void {
  state.filter = filter;
  const first = filteredSessions().at(0);
  state.selectedSessionId = first?.id ?? null;
  state.voucherPage = 0;
  notify();
  if (state.selectedSessionId) {
    void refreshSelectedSession();
  }
}

export function setCreateModalOpen(open: boolean): void {
  state.createModalOpen = open;
  if (open) {
    state.createDraft = defaultCreateSessionDraft();
    state.createErrors = {};
  }
  notify();
}

export function updateCreateDraftField(field: keyof CreateSessionDraft, value: string): void {
  state.createDraft = { ...state.createDraft, [field]: value };
  state.createErrors = { ...state.createErrors };
  delete state.createErrors[field];
  delete state.createErrors.form;
}

export function setVoucherPage(page: number): void {
  state.voucherPage = Math.max(0, page);
  notify();
}

export function filteredSessions(snapshot: SessionsState = state): StreamingSessionRecord[] {
  return sortSessions(snapshot.sessions).filter((session) => {
    if (snapshot.filter === 'active') return session.status === 'active' || session.status === 'pending';
    return session.status === snapshot.filter;
  });
}

export function selectedDetail(snapshot: SessionsState = state): StreamingSessionDetail | null {
  if (!snapshot.selectedSessionId) return null;
  return snapshot.details[snapshot.selectedSessionId] ?? null;
}

const NATIVE_SOL_PSEUDO_MINT = '11111111111111111111111111111111';

export function validateCreateDraft(
  draft: CreateSessionDraft,
  now: number = Date.now(),
): { valid: boolean; errors: Record<string, string>; body?: CreateSessionRequestBody } {
  const errors: Record<string, string> = {};
  const tokenMint = draft.tokenMint.trim();
  if (!SOLANA_ADDRESS_REGEX.test(tokenMint)) {
    errors.tokenMint = 'Enter a valid token mint address.';
  } else if (tokenMint === NATIVE_SOL_PSEUDO_MINT) {
    errors.tokenMint =
      'Native SOL streaming is not supported yet. Wrap SOL to wSOL (So11…112) or pick a regular SPL token like USDC.';
  }

  const capAmount = normalizeDecimal(draft.capAmount);
  if (!DECIMAL_AMOUNT_REGEX.test(capAmount) || Number(capAmount) <= 0) {
    errors.capAmount = 'Enter a positive token amount with up to 6 decimals.';
  }

  const duration = Number(draft.durationMinutes);
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) {
    errors.durationMinutes = 'Choose an expiry between 1 and 60 minutes.';
  }

  const allowlist = parseAllowlistDraft(draft.recipientAllowlist);
  if (allowlist.invalid.length > 0) {
    errors.recipientAllowlist = `Invalid recipient address: ${allowlist.invalid[0]}`;
  } else if (allowlist.valid.length > MAX_RECIPIENT_ALLOWLIST) {
    errors.recipientAllowlist = `Use ${MAX_RECIPIENT_ALLOWLIST} or fewer recipient addresses.`;
  }

  if (Object.keys(errors).length > 0) return { valid: false, errors };
  const expiresAt = new Date(now + duration * 60_000).toISOString();
  return {
    valid: true,
    errors: {},
    body: {
      tokenMint,
      capAmount,
      expiresAt,
      ...(allowlist.valid.length ? { recipientAllowlist: allowlist.valid } : {}),
      cluster: currentCluster(),
      tokenDecimals: 6,
    },
  };
}

export async function loadSessions(force = false): Promise<void> {
  if (state.status === 'loading' && !force) return;
  state.status = 'loading';
  state.errorMessage = '';
  notify();
  try {
    const sessions = await listStreamingSessions('all');
    state.sessions = sortSessions(sessions);
    state.lastFetchedAt = Date.now();
    state.status = 'loaded';
    state.errorMessage = '';
    state.details = pruneDetails(state.details, sessions);
    if (!state.selectedSessionId || !state.sessions.some((session) => session.id === state.selectedSessionId)) {
      state.selectedSessionId = filteredSessions().at(0)?.id ?? state.sessions.at(0)?.id ?? null;
    }
    notify();
    if (state.selectedSessionId) await refreshSelectedSession();
  } catch (err) {
    state.errorMessage = friendlyStreamingError(err);
    state.status = 'error';
    notify();
  }
}

export async function selectSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  state.selectedSessionId = sessionId;
  state.voucherPage = 0;
  notify();
  await refreshSelectedSession();
}

export async function openSessionDetail(sessionId: string): Promise<void> {
  if (!sessionId) return;
  state.selectedSessionId = sessionId;
  state.voucherPage = 0;
  state.errorMessage = '';
  notify();
  if (!state.sessions.some((session) => session.id === sessionId)) {
    await loadSessions(true);
    state.selectedSessionId = sessionId;
    state.voucherPage = 0;
    notify();
  }
  await refreshSelectedSession();
  const session = state.details[sessionId]?.session ??
    state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    state.filter = filterForSessionStatus(session.status);
    notify();
  }
}

export async function refreshSelectedSession(): Promise<void> {
  const sessionId = state.selectedSessionId;
  if (!sessionId) return;
  try {
    const detail = await getStreamingSession(sessionId);
    state.details = { ...state.details, [sessionId]: detail };
    state.sessions = mergeSessionRecords([detail.session], state.sessions);
    state.errorMessage = '';
    if (state.status === 'idle') state.status = 'loaded';
    notify();
  } catch (err) {
    state.errorMessage = friendlyStreamingError(err);
    if (state.status === 'idle' || state.status === 'loading') state.status = 'error';
    notify();
  }
}

export async function submitCreateSession(): Promise<boolean> {
  const validation = validateCreateDraft(state.createDraft);
  state.createErrors = validation.errors;
  if (!validation.valid || !validation.body) {
    notify();
    return false;
  }
  state.busy = 'create';
  state.notice = null;
  notify();
  try {
    const nativeSigner = await prepareNativeStreamingSigner(validation.body);
    const signerRuntime = nativeSigner?.signerRuntime;
    let result: Awaited<ReturnType<typeof createStreamingSession>>;
    try {
      result = await createStreamingSession({
        ...validation.body,
        ...(nativeSigner && signerRuntime ? {
          ephemeralSignerPubkey: nativeSigner.ephemeralSignerPubkey,
          signerRuntime,
          metadata: {
            signerRuntime,
          },
        } : {}),
      });
    } catch (err) {
      if (nativeSigner) {
        void revokeNativeStreamingSession(nativeSigner.signerId);
      }
      throw err;
    }
    if (nativeSigner) {
      await bindNativeStreamingSession(result.session, nativeSigner.signerId, validation.body);
    }
    state.sessions = mergeSessionRecords([result.session], state.sessions);
    state.details = {
      ...state.details,
      [result.session.id]: { session: result.session, vouchers: [] },
    };
    state.selectedSessionId = result.session.id;
    state.filter = 'active';
    state.createModalOpen = false;
    state.createDraft = defaultCreateSessionDraft();
    state.createErrors = {};
    executeStreamingApproval('grant', result.session, result.approveTx);
    state.notice = { tone: 'pending', message: 'Open your wallet to approve the session grant.' };
    notify();
    return true;
  } catch (err) {
    state.createErrors = { form: friendlyStreamingError(err) };
    state.notice = { tone: 'error', message: friendlyStreamingError(err) };
    notify();
    return false;
  } finally {
    state.busy = false;
    notify();
  }
}

export async function requestRevokeSelectedSession(): Promise<boolean> {
  const sessionId = state.selectedSessionId;
  const session = sessionId ? state.sessions.find((candidate) => candidate.id === sessionId) : undefined;
  if (!sessionId || !session) return false;
  state.busy = 'revoke';
  state.notice = null;
  notify();
  try {
    const result = await revokeStreamingSession(sessionId);
    const nextSession = result.session ?? session;
    if (result.session) {
      state.sessions = mergeSessionRecords([result.session], state.sessions);
      state.details = {
        ...state.details,
        [sessionId]: {
          ...(state.details[sessionId] ?? { session: result.session, vouchers: [] }),
          session: result.session,
        },
      };
    }
    executeStreamingApproval('revoke', nextSession, result.revokeTx);
    state.notice = { tone: 'pending', message: 'Open your wallet to revoke the session delegate.' };
    notify();
    return true;
  } catch (err) {
    state.notice = { tone: 'error', message: friendlyStreamingError(err) };
    notify();
    return false;
  } finally {
    state.busy = false;
    notify();
  }
}

export async function submitStreamingVoucherSpend(input: {
  sessionId: string;
  amount: string;
  recipient: string;
  nonce?: string;
  issuedAt?: string;
}): Promise<SubmitVoucherResponse> {
  const detail = state.details[input.sessionId] ?? await getStreamingSession(input.sessionId);
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const voucher = {
    schema: 'streaming/voucher/0.1',
    sessionId: input.sessionId,
    nonce: input.nonce ?? `voucher_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    amount: input.amount,
    recipient: input.recipient,
    issuedAt,
  };
  const envelope = await callStreamingBridge('signVoucher', {
    sessionId: input.sessionId,
    voucher,
  });
  if (!hasNativeStreamingBridge()) {
    const relayed = envelope.result as SubmitVoucherResponse | undefined;
    if (relayed && typeof relayed === 'object') return relayed;
  }
  const result = bridgeResult(envelope, 'signVoucher');
  const signature = stringField(result.signature);
  if (!signature) {
    throw new StreamingApiError('invalid_response', 'Native streaming signer did not return a voucher signature.');
  }
  const submitted = await submitStreamingVoucher(input.sessionId, {
    voucher: {
      ...voucher,
      signature,
    },
  });
  state.details = {
    ...state.details,
    [input.sessionId]: {
      ...detail,
      session: detail.session,
      vouchers: submitted.voucher ? [...detail.vouchers, submitted.voucher] : detail.vouchers,
    },
  };
  await refreshSelectedSession();
  return submitted;
}

export function handleStreamingApprovalStatus(input: StreamingApprovalCompletedDetail): void {
  if (input.status === 'failed') {
    state.notice = {
      tone: 'error',
      message: input.error || `Streaming ${input.operation} approval failed.`,
    };
  } else if (input.status === 'queued') {
    state.notice = {
      tone: 'pending',
      message: input.operation === 'grant'
        ? 'Grant transaction is ready in Sign Approval.'
        : 'Revoke transaction is ready in Sign Approval.',
    };
  } else {
    state.notice = {
      tone: input.status === 'confirmed' ? 'success' : 'pending',
      message: input.operation === 'grant'
        ? input.status === 'confirmed'
          ? 'Grant transaction confirmed. Session is active.'
          : 'Grant transaction submitted. Waiting for confirmation.'
        : input.status === 'confirmed'
          ? 'Revoke transaction confirmed.'
          : 'Revoke transaction submitted. Waiting for confirmation.',
    };
    if (input.operation === 'grant' && isNativeSignerSession(input.sessionId)) {
      void activateNativeStreamingSession(input.sessionId);
    } else if (input.operation === 'revoke' && isNativeSignerSession(input.sessionId)) {
      void revokeNativeStreamingSession(input.sessionId);
    }
    state.selectedSessionId = input.sessionId;
    void syncStreamingApprovalStatus(input);
  }
  notify();
}

export function confirmSelectedSessionTransaction(): boolean {
  const sessionId = state.selectedSessionId;
  const session = sessionId ? state.sessions.find((candidate) => candidate.id === sessionId) : undefined;
  if (!session) return false;
  const revokeTx = sessionTxState(session, 'revoke');
  const grantTx = sessionTxState(session, 'grant');
  const pending = revokeTx?.status === 'submitted'
    ? { operation: 'revoke' as const, txid: revokeTx.txid, approvalId: revokeTx.approvalId }
    : grantTx?.status === 'submitted'
      ? { operation: 'grant' as const, txid: grantTx.txid, approvalId: grantTx.approvalId }
      : null;
  if (!pending) return false;
  executeStreamingApproval(pending.operation, session, {
    txBase64: '',
    cluster: session.cluster,
    tokenMint: session.tokenMint,
    totalAmount: pending.operation === 'grant' ? session.capAmount : undefined,
  }, pending.txid, pending.approvalId);
  state.notice = { tone: 'pending', message: 'Checking session transaction confirmation.' };
  notify();
  return true;
}

export function sessionTxState(
  session: StreamingSessionRecord,
  operation: StreamingApprovalOperation,
): StreamingSessionTxState | null {
  const metadata = session.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = metadata[operation === 'grant' ? 'grantTx' : 'revokeTx'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const txid = stringField(record.txid);
  const status = stringField(record.status);
  if (!txid || (status !== 'submitted' && status !== 'confirmed' && status !== 'failed')) return null;
  return {
    txid,
    status,
    ...(stringField(record.txStatus) ? { txStatus: stringField(record.txStatus) } : {}),
    ...(stringField(record.approvalId) ? { approvalId: stringField(record.approvalId) } : {}),
    ...(stringField(record.updatedAt) ? { updatedAt: stringField(record.updatedAt) } : {}),
  };
}

export function startSessionDetailPolling(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (detailPollTimer !== null) return stopSessionDetailPolling;
  detailPollTimer = window.setInterval(() => {
    if (!state.selectedSessionId || pollInFlight) return;
    pollInFlight = true;
    void refreshSelectedSession().finally(() => {
      pollInFlight = false;
    });
  }, SESSIONS_DETAIL_POLL_MS);
  return stopSessionDetailPolling;
}

export function stopSessionDetailPolling(): void {
  if (typeof window === 'undefined') return;
  if (detailPollTimer !== null) {
    window.clearInterval(detailPollTimer);
    detailPollTimer = null;
  }
  pollInFlight = false;
}

export function __resetSessionsStateForTests(next: Partial<SessionsState> = {}): void {
  stopSessionDetailPolling();
  state.status = next.status ?? 'idle';
  state.sessions = next.sessions ?? [];
  state.details = next.details ?? {};
  state.selectedSessionId = next.selectedSessionId ?? null;
  state.filter = next.filter ?? 'active';
  state.errorMessage = next.errorMessage ?? '';
  state.busy = next.busy ?? false;
  state.createModalOpen = next.createModalOpen ?? false;
  state.createDraft = next.createDraft ?? defaultCreateSessionDraft();
  state.createErrors = next.createErrors ?? {};
  state.voucherPage = next.voucherPage ?? 0;
  state.lastFetchedAt = next.lastFetchedAt ?? 0;
  state.notice = next.notice ?? null;
  notify();
}

async function prepareNativeStreamingSigner(
  body: CreateSessionRequestBody,
): Promise<{ signerId: string; ephemeralSignerPubkey: string; signerRuntime: 'android-native' | 'ios-native' } | null> {
  if (!hasNativeStreamingBridge()) return null;
  const runtime = nativeStreamingRuntime();
  if (!runtime) return null;
  const envelope = await callStreamingBridge('prepareSessionSigner', {
    tokenMint: body.tokenMint,
    capAmount: body.capAmount,
    expiresAt: body.expiresAt,
    tokenDecimals: body.tokenDecimals,
  });
  const result = bridgeResult(envelope, 'prepareSessionSigner');
  const signerId = stringField(result.signerId);
  const ephemeralSignerPubkey = stringField(result.ephemeralSignerPubkey);
  if (!signerId || !ephemeralSignerPubkey) {
    throw new StreamingApiError('invalid_response', 'Native streaming signer did not return signerId and ephemeralSignerPubkey.');
  }
  return { signerId, ephemeralSignerPubkey, signerRuntime: runtime };
}

async function bindNativeStreamingSession(
  session: StreamingSessionRecord,
  signerId: string,
  body: CreateSessionRequestBody,
): Promise<void> {
  if (!hasNativeStreamingBridge()) return;
  bridgeResult(await callStreamingBridge('createSession', {
    sessionId: session.id,
    signerId,
    ephemeralSignerPubkey: session.ephemeralSignerPubkey,
    expiresAt: session.expiresAt,
    capAmount: session.capAmount,
    spentAmount: session.spentAmount,
    remainingAmount: remainingAmount(session),
    tokenDecimals: body.tokenDecimals,
    tokenSymbol: 'USDC',
    ...(session.recipientAllowlist ? { recipientAllowlist: session.recipientAllowlist } : {}),
  }), 'createSession');
}

async function activateNativeStreamingSession(sessionId: string): Promise<void> {
  if (!hasNativeStreamingBridge()) return;
  try {
    bridgeResult(await callStreamingBridge('activateSession', { sessionId }), 'activateSession');
  } catch (err) {
    state.notice = { tone: 'error', message: friendlyStreamingError(err) };
    notify();
  }
}

async function revokeNativeStreamingSession(sessionIdOrSignerId: string): Promise<void> {
  if (!hasNativeStreamingBridge()) return;
  try {
    bridgeResult(await callStreamingBridge('revokeLocalSession', { sessionId: sessionIdOrSignerId }), 'revokeLocalSession');
  } catch {
    // Local cleanup should not mask the server-side session/revoke result.
  }
}

function bridgeResult(envelope: BridgeEnvelope, method: string): Record<string, unknown> {
  if (!envelope.ok) {
    const message = envelope.error?.message ?? envelope.message ?? `Native streaming ${method} failed.`;
    throw new StreamingApiError('network_error', message);
  }
  const result = envelope.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new StreamingApiError('invalid_response', `Native streaming ${method} returned no result.`);
  }
  return result as Record<string, unknown>;
}

function remainingAmount(session: StreamingSessionRecord): string {
  const cap = Number(session.capAmount);
  const spent = Number(session.spentAmount);
  if (!Number.isFinite(cap) || !Number.isFinite(spent)) return session.capAmount;
  return Math.max(0, cap - spent).toFixed(6).replace(/\.?0+$/, '');
}

function isNativeSignerSession(sessionId: string): boolean {
  const session = state.details[sessionId]?.session ?? state.sessions.find((candidate) => candidate.id === sessionId);
  return session?.metadata?.signerRuntime === 'android-native' || session?.metadata?.signerRuntime === 'ios-native';
}

async function syncStreamingApprovalStatus(input: StreamingApprovalCompletedDetail): Promise<void> {
  if (!input.txid || (input.status !== 'submitted' && input.status !== 'confirmed')) {
    await refreshSelectedSession();
    return;
  }
  try {
    const body = streamingApprovalSignedBody({
      operation: input.operation,
      txid: input.txid,
      approvalId: input.approvalId,
      status: input.status,
      txStatus: input.status === 'confirmed' ? 'confirmed' : 'pending',
    });
    const response = input.operation === 'grant'
      ? await recordGrantSigned(input.sessionId, body)
      : await recordRevokeSigned(input.sessionId, body);
    if (response.session) {
      state.sessions = mergeSessionRecords([response.session], state.sessions);
      state.details = {
        ...state.details,
        [input.sessionId]: {
          ...(state.details[input.sessionId] ?? { session: response.session, vouchers: [] }),
          session: response.session,
        },
      };
    }
    await refreshSelectedSession();
  } catch (err) {
    state.notice = {
      tone: 'error',
      message: `Session ${input.operation} callback failed: ${friendlyStreamingError(err)}`,
    };
    notify();
  }
}

function executeStreamingApproval(
  operation: StreamingApprovalOperation,
  session: StreamingSessionRecord,
  tx: { txBase64: string; cluster?: WorkflowCluster; description?: string; tokenMint?: string; totalAmount?: string },
  txid?: string,
  approvalId?: string,
): void {
  dispatchStreamingApprovalExecuteRequested({
    source: 'streaming_session',
    operation,
    sessionId: session.id,
    tx: {
      ...tx,
      cluster: tx.cluster ?? session.cluster,
      tokenMint: tx.tokenMint ?? session.tokenMint,
      totalAmount: tx.totalAmount ?? (operation === 'grant' ? session.capAmount : undefined),
    },
    cluster: tx.cluster ?? session.cluster,
    walletAddress: session.walletAddress,
    callbackPath: `/api/streaming/sessions/${encodeURIComponent(session.id)}/${operation === 'grant' ? 'grant-signed' : 'revoke-signed'}`,
    summary: operation === 'grant'
      ? `Grant streaming session ${shortId(session.id)} up to ${session.capAmount} USDC`
      : `Revoke streaming session ${shortId(session.id)}`,
    ...(approvalId ? { approvalId } : {}),
    ...(txid ? { txid } : {}),
  });
}

function sortSessions(sessions: readonly StreamingSessionRecord[]): StreamingSessionRecord[] {
  return [...sessions].sort((left, right) => {
    const rank = statusRank(left.status) - statusRank(right.status);
    if (rank !== 0) return rank;
    return right.createdAt.localeCompare(left.createdAt);
  });
}

function statusRank(status: StreamingSessionRecord['status']): number {
  if (status === 'active' || status === 'pending') return 0;
  if (status === 'expired') return 1;
  if (status === 'revoked') return 2;
  return 3;
}

function filterForSessionStatus(status: StreamingSessionRecord['status']): SessionsStatusFilter {
  return status === 'pending' ? 'active' : status;
}

function mergeSessionRecords(
  updates: readonly StreamingSessionRecord[],
  existing: readonly StreamingSessionRecord[],
): StreamingSessionRecord[] {
  const byId = new Map<string, StreamingSessionRecord>();
  for (const session of existing) byId.set(session.id, session);
  for (const session of updates) {
    const current = byId.get(session.id);
    if (!current || session.updatedAt.localeCompare(current.updatedAt) >= 0) {
      byId.set(session.id, session);
    }
  }
  return sortSessions([...byId.values()]);
}

function pruneDetails(
  details: Record<string, StreamingSessionDetail>,
  sessions: readonly StreamingSessionRecord[],
): Record<string, StreamingSessionDetail> {
  const ids = new Set(sessions.map((session) => session.id));
  const next: Record<string, StreamingSessionDetail> = {};
  for (const [id, detail] of Object.entries(details)) {
    if (ids.has(id)) next[id] = detail;
  }
  return next;
}

function parseAllowlistDraft(value: string): { valid: string[]; invalid: string[] } {
  const entries = value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (SOLANA_ADDRESS_REGEX.test(entry)) {
      if (!valid.includes(entry)) valid.push(entry);
    } else {
      invalid.push(entry);
    }
  }
  return { valid, invalid };
}

function normalizeDecimal(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('.') ? `0${trimmed}` : trimmed;
}

function currentCluster(): WorkflowCluster {
  const cluster = getConnectedCluster();
  if (cluster === 'devnet' || cluster === 'testnet' || cluster === 'localnet' || cluster === 'mainnet-beta') return cluster;
  return 'mainnet-beta';
}

function friendlyStreamingError(err: unknown): string {
  if (err instanceof StreamingApiError && err.code === 'not_implemented') {
    return 'Streaming session routes are not available on this dev server yet.';
  }
  // A 401 here means the cloud session expired/dropped mid-use. Surface the same
  // calm sign-in copy instead of a raw "HTTP 401" string.
  if (err instanceof StreamingApiError && err.status === 401) {
    return 'Sign in to Agentic Cloud before loading cloud workflow data.';
  }
  if (err instanceof Error) return err.message;
  return 'Streaming session request failed.';
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function notify(): void {
  for (const listener of listeners) listener();
}
