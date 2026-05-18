import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  StreamingSessionRecord,
  StreamingVoucherRecord,
} from '@solana-agent-wallet-adapter/workflow';

vi.mock('../../devGate.js', () => ({
  DEV_LAYER1_ENABLED: true,
  DEV_WALLET_ALLOWLIST: Object.freeze(['4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd']),
  isDevWallet: (addr?: string | null) => addr === '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
}));

const DEV_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const RECIPIENT = '7tQAS3PCEHKekfA5xkkFqRf9aCkqg8aLg5jLA7MwYc8M';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

import { findDevTab, listDevTabs } from '../../devTabRegistry.js';
import {
  __resetSessionsStateForTests,
  getSessionsState,
  loadSessions,
  requestRevokeSelectedSession,
  stopSessionDetailPolling,
} from '../../sessionState.js';
import {
  STREAMING_APPROVAL_EXECUTE_REQUESTED_EVENT,
  streamingApprovalSignedBody,
} from '../../streamingApprovalEvents.js';
import { setConnectedAddress, setConnectedCluster } from '../../walletState.js';
import { __sessionsForTests } from '../sessions.js';

function makeSession(overrides: Partial<StreamingSessionRecord> = {}): StreamingSessionRecord {
  return {
    id: 'sess_active_001',
    walletAddress: DEV_WALLET,
    cluster: 'mainnet-beta',
    tokenMint: USDC,
    delegatePubkey: '6oU9pmVdVRzzxHdh8Qkpi6QH3k42YiFQhJ1Npz5JvFtB',
    ephemeralSignerPubkey: '4Qh5YQ5u66q5hWN14W3RB9v7KATqZ1zhNQDbAtuLpypm',
    capAmount: '25',
    spentAmount: '7.5',
    expiresAt: '2026-05-16T13:00:00.000Z',
    status: 'active',
    recipientAllowlist: [RECIPIENT],
    createdAt: '2026-05-16T12:00:00.000Z',
    updatedAt: '2026-05-16T12:05:00.000Z',
    ...overrides,
  };
}

function makeVoucher(overrides: Partial<StreamingVoucherRecord> = {}): StreamingVoucherRecord {
  return {
    id: 'voucher_001',
    sessionId: 'sess_active_001',
    nonce: 'n-001',
    amount: '0.25',
    recipient: RECIPIENT,
    voucherHash: '64e7f49f5f7ed1d9a1f7ff0f7460a103e356c87b5f16f7ec875dbbf29d7f1111',
    signature: '5D4Tsig',
    issuedAt: '2026-05-16T12:10:00.000Z',
    createdAt: '2026-05-16T12:10:00.000Z',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sessions dev tab', () => {
  type FetchMock = ReturnType<typeof vi.fn>;
  let fetchMock: FetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    fetchMock = vi.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    setConnectedAddress(DEV_WALLET);
    setConnectedCluster('mainnet-beta');
    __resetSessionsStateForTests({
      status: 'loaded',
      sessions: [makeSession()],
      selectedSessionId: 'sess_active_001',
      details: {
        sess_active_001: {
          session: makeSession(),
          vouchers: [makeVoucher()],
          receiptUrl: '/api/streaming/sessions/sess_active_001/receipt',
        },
      },
    });
  });

  afterEach(() => {
    stopSessionDetailPolling();
    vi.useRealTimers();
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
    setConnectedAddress(undefined);
    setConnectedCluster(undefined);
    __resetSessionsStateForTests();
  });

  it('registers the sessions tab with the registry', () => {
    const tab = findDevTab('sessions');
    expect(tab).toBeDefined();
    expect(tab?.label).toBe('Sessions');
    expect(listDevTabs().map((t) => t.id)).toContain('sessions');
    expect(tab?.guard()).toBe(true);
  });

  it('renders an active session row with spend and cap', () => {
    const html = __sessionsForTests.renderSessionsPanel();
    expect(html).toContain('data-dev-tab-use-cases="streaming-payment-sessions"');
    expect(html).toContain('Pay as work happens');
    expect(html).toContain('sess_active_001');
    expect(html).toContain('7.5 / 25 USDC');
    expect(html).toContain('sessions-pill--active');
  });

  it('renders voucher rows, revoke button, allowlist, and receipt link in detail', () => {
    const html = __sessionsForTests.detailHtml();
    expect(html).toContain('sessions-voucher-row');
    expect(html).toContain('0.25');
    expect(html).toContain('7tQA...Yc8M');
    expect(html).toContain('data-sessions-revoke="sess_active_001"');
    expect(html).toContain('/api/streaming/sessions/sess_active_001/receipt');
  });

  it('loads all session status buckets from render-web', async () => {
    const expired = makeSession({
      id: 'sess_expired_001',
      status: 'expired',
      expiresAt: '2026-05-16T11:00:00.000Z',
    });
    __resetSessionsStateForTests({ status: 'idle' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/streaming/sessions?status=all') {
        return jsonResponse(200, { sessions: [expired] });
      }
      if (url === '/api/streaming/sessions/sess_expired_001') {
        return jsonResponse(200, { session: expired, vouchers: [] });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    await loadSessions(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/streaming/sessions?status=all');
    expect(getSessionsState().sessions.map((session) => session.status)).toEqual(['expired']);
  });

  it('dispatches inline streaming approval execution after revoke prepares a tx', async () => {
    const target = new EventTarget();
    (globalThis as { window?: EventTarget }).window = target;
    (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent = class TestCustomEvent<T> extends Event {
      detail: T;

      constructor(type: string, init: CustomEventInit<T>) {
        super(type);
        this.detail = init.detail as T;
      }
    } as unknown as typeof CustomEvent;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/streaming/sessions/sess_active_001/revoke') {
        return jsonResponse(200, {
          session: makeSession({ status: 'active' }),
          revokeTx: {
            txBase64: 'AQIDBA==',
            cluster: 'mainnet-beta',
            description: 'Revoke streaming delegate.',
          },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const details: unknown[] = [];
    target.addEventListener(STREAMING_APPROVAL_EXECUTE_REQUESTED_EVENT, (event) => {
      details.push((event as CustomEvent<unknown>).detail);
    });

    const html = __sessionsForTests.detailHtml();
    expect(html).toContain('data-sessions-revoke="sess_active_001"');
    await requestRevokeSelectedSession();
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      source: 'streaming_session',
      operation: 'revoke',
      sessionId: 'sess_active_001',
      callbackPath: '/api/streaming/sessions/sess_active_001/revoke-signed',
      tx: { txBase64: 'AQIDBA==' },
    });
  });

  it('renders expired badge state', () => {
    const html = __sessionsForTests.sessionRowHtml(
      makeSession({ status: 'expired', expiresAt: '2026-05-16T11:00:00.000Z' }),
      null,
    );
    expect(html).toContain('sessions-pill--expired');
    expect(html).toContain('Expired');
  });

  it('allows expired sessions to queue revoke before settlement', () => {
    const expired = makeSession({
      id: 'sess_expired_001',
      status: 'expired',
      expiresAt: '2026-05-16T11:00:00.000Z',
    });
    __resetSessionsStateForTests({
      status: 'loaded',
      sessions: [expired],
      selectedSessionId: 'sess_expired_001',
      details: {
        sess_expired_001: { session: expired, vouchers: [] },
      },
    });

    const html = __sessionsForTests.detailHtml();
    expect(html).toContain('data-sessions-revoke="sess_expired_001"');
    expect(html).not.toContain('data-sessions-revoke="sess_expired_001" disabled');
  });

  it('opens a specific session detail for Spend deep links', async () => {
    const settled = makeSession({
      id: 'sess_settled_001',
      status: 'settled',
      spentAmount: '25',
      expiresAt: '2026-05-16T11:00:00.000Z',
    });
    __resetSessionsStateForTests({ status: 'idle' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/streaming/sessions?status=all') {
        return jsonResponse(200, { sessions: [settled] });
      }
      if (url === '/api/streaming/sessions/sess_settled_001') {
        return jsonResponse(200, { session: settled, vouchers: [] });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    await __sessionsForTests.openSessionDetail('sess_settled_001');
    expect(getSessionsState().selectedSessionId).toBe('sess_settled_001');
    expect(getSessionsState().filter).toBe('settled');
  });

  it('validates create-modal inputs before submit', () => {
    const invalid = __sessionsForTests.validateCreateDraft({
      tokenMint: 'not-a-mint',
      capAmount: '0',
      durationMinutes: '90',
      recipientAllowlist: 'bad-recipient',
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.tokenMint).toMatch(/valid token mint/);
    expect(invalid.errors.capAmount).toMatch(/positive/);
    expect(invalid.errors.durationMinutes).toMatch(/between 1 and 60/);
    expect(invalid.errors.recipientAllowlist).toMatch(/Invalid recipient/);

    const valid = __sessionsForTests.validateCreateDraft({
      tokenMint: USDC,
      capAmount: '10.5',
      durationMinutes: '30',
      recipientAllowlist: RECIPIENT,
    });
    expect(valid.valid).toBe(true);
    expect(valid.body).toMatchObject({
      tokenMint: USDC,
      capAmount: '10.5',
      recipientAllowlist: [RECIPIENT],
      cluster: 'mainnet-beta',
    });
    expect(valid.body?.expiresAt).toBe('2026-05-16T12:30:00.000Z');

    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const tooManyRecipients = Array.from(
      { length: 65 },
      (_, index) => `${'1'.repeat(30)}${alphabet[Math.floor(index / alphabet.length)]}${alphabet[index % alphabet.length]}`,
    ).join(',');
    const tooLarge = __sessionsForTests.validateCreateDraft({
      tokenMint: USDC,
      capAmount: '1',
      durationMinutes: '10',
      recipientAllowlist: tooManyRecipients,
    });
    expect(tooLarge.valid).toBe(false);
    expect(tooLarge.errors.recipientAllowlist).toMatch(/64 or fewer/);

    // P4.2 — native SOL pseudo-mint should be rejected with a friendly error
    // pointing users at wSOL.
    const nativeSol = __sessionsForTests.validateCreateDraft({
      tokenMint: '11111111111111111111111111111111',
      capAmount: '1',
      durationMinutes: '10',
      recipientAllowlist: '',
    });
    expect(nativeSol.valid).toBe(false);
    expect(nativeSol.errors.tokenMint).toMatch(/wSOL|Native SOL/i);
  });

  it('maps signed approval callbacks to render-web route fields', () => {
    expect(streamingApprovalSignedBody({
      operation: 'grant',
      txid: 'tx_grant',
      approvalId: 'approval_1',
      status: 'submitted',
      txStatus: 'pending',
    })).toMatchObject({
      approveTxid: 'tx_grant',
      txid: 'tx_grant',
      signature: 'tx_grant',
      approvalId: 'approval_1',
      status: 'submitted',
      txStatus: 'pending',
    });
    expect(streamingApprovalSignedBody({
      operation: 'revoke',
      txid: 'tx_revoke',
      approvalId: 'approval_2',
      status: 'confirmed',
      txStatus: 'confirmed',
    })).toMatchObject({
      revokeTxid: 'tx_revoke',
      txid: 'tx_revoke',
    });
  });
});
