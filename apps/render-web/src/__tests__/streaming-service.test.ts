import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  generateEphemeralKeypair,
  signVoucher,
  type EphemeralKeypair,
  type Voucher,
} from '@solana-agent-wallet-adapter/streaming-sessions';

import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import { materializeStreamingSettlements, settleStreamingSession } from '../cloud/settlementService.js';
import {
  decryptSessionDelegateKey,
  MemoryStreamingStore,
  StreamingService,
  type StreamingStore,
} from '../cloud/streamingService.js';

const RECENT_BLOCKHASH = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();
const TOKEN_MINT = Keypair.generate().publicKey.toBase58();

describe('streaming sessions service', () => {
  it('accepts a valid voucher and rejects invalid signature, allowlist, cap, and expiry cases', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const blockedRecipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const session = await createActiveSession(ctx, {
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
      recipientAllowlist: [recipient],
    });

    const accepted = await ctx.service.acceptVoucher({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      voucher: voucher(ctx.keypair, session.sessionId, 'nonce_ok', '0.25', recipient),
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.remaining).toBe('0.75');
    expect(accepted.session.spentAmount).toBe('0.25');

    await expectCode(
      ctx.service.acceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        voucher: voucher(generateEphemeralKeypair(), session.sessionId, 'nonce_bad_sig', '0.01', recipient),
      }),
      'voucher_invalid_signature',
    );
    await expectCode(
      ctx.service.acceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        voucher: voucher(ctx.keypair, session.sessionId, 'nonce_blocked', '0.01', blockedRecipient),
      }),
      'voucher_recipient_not_allowed',
    );
    await expectCode(
      ctx.service.acceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        voucher: voucher(ctx.keypair, session.sessionId, 'nonce_over_cap', '0.76', recipient),
      }),
      'voucher_exceeds_remaining',
    );

    ctx.setNow('2026-05-16T13:00:00.000Z');
    await expectCode(
      ctx.service.acceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        voucher: voucher(ctx.keypair, session.sessionId, 'nonce_expired', '0.01', recipient, '2026-05-16T12:59:59.000Z'),
      }),
      'session_expired',
    );
  });

  it('detects replayed voucher nonces', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const session = await createActiveSession(ctx, {
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });
    const signed = voucher(ctx.keypair, session.sessionId, 'nonce_replay', '0.05', recipient);

    await ctx.service.acceptVoucher({ walletAddress: WALLET, sessionId: session.sessionId, voucher: signed });
    await expectCode(
      ctx.service.acceptVoucher({ walletAddress: WALLET, sessionId: session.sessionId, voucher: signed }),
      'voucher_replay',
    );
  });

  it('creates Android-native signer sessions without server delegate key material', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const nativeKeypair = generateEphemeralKeypair();
    const created = await ctx.service.createSession({
      walletAddress: WALLET,
      tokenMint: TOKEN_MINT,
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
      cluster: 'devnet',
      ephemeralSignerPubkey: nativeKeypair.publicKey,
      signerRuntime: 'android-native',
    });
    await ctx.service.recordGrantSigned({
      walletAddress: WALLET,
      sessionId: created.session.sessionId,
      approveTxid: `APPROVE_${created.session.sessionId}`,
    });

    expect(created.session.delegatePubkey).toBe(nativeKeypair.publicKey);
    expect(created.session.ephemeralSignerPubkey).toBe(nativeKeypair.publicKey);
    expect(created.session.metadata?.signerRuntime).toBe('android-native');
    expect(() => decryptSessionDelegateKey(created.session)).toThrow(/Android native signer/);

    const accepted = await ctx.service.acceptVoucher({
      walletAddress: WALLET,
      sessionId: created.session.sessionId,
      voucher: voucher(nativeKeypair, created.session.sessionId, 'nonce_native', '0.05', recipient),
    });
    expect(accepted.accepted).toBe(true);

    await expectCode(
      ctx.service.signAndAcceptVoucher({
        walletAddress: WALLET,
        sessionId: created.session.sessionId,
        amount: '0.05',
        recipient,
      }),
      'native_signer_required',
    );
  });

  it('server-relayed voucher signing accepts valid spends and preserves replay checks', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const session = await createActiveSession(ctx, {
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });

    const accepted = await ctx.service.signAndAcceptVoucher({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      amount: '0.10',
      recipient,
      nonce: 'nonce_server_signed',
    });

    expect(accepted.accepted).toBe(true);
    expect(accepted.remaining).toBe('0.9');
    expect(accepted.voucher.signature).toBeTruthy();
    expect(accepted.voucher.voucher).toMatchObject({
      sessionId: session.sessionId,
      nonce: 'nonce_server_signed',
      amount: '0.10',
      recipient,
    });

    await expectCode(
      ctx.service.signAndAcceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        amount: '0.01',
        recipient,
        nonce: 'nonce_server_signed',
      }),
      'voucher_replay',
    );
  });

  it('revoke marks the session revoked and blocks later vouchers', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const session = await createActiveSession(ctx, {
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });

    const revoked = await ctx.service.revokeSession({ walletAddress: WALLET, sessionId: session.sessionId });
    expect(revoked.session.status).toBe('revoked');
    expect(revoked.revokeTx.kind).toBe('revoke_delegate');

    await expectCode(
      ctx.service.acceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        voucher: voucher(ctx.keypair, session.sessionId, 'nonce_after_revoke', '0.01', recipient),
      }),
      'session_revoked',
    );
  });

  it('partially settles chunked vouchers and leaves failed later batches unsettled', async () => {
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const evidenceStore = new MemoryEvidenceStore();
    const session = await createActiveSession(ctx, {
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });
    for (let i = 0; i < 11; i += 1) {
      await ctx.service.acceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        voucher: voucher(
          ctx.keypair,
          session.sessionId,
          `nonce_chunk_${i}`,
          '0.05',
          Keypair.generate().publicKey.toBase58(),
        ),
      });
    }

    let submitCalls = 0;
    const result = await materializeStreamingSettlements({
      streamingStore: ctx.store,
      evidenceStore,
      clock: ctx.clock,
      thresholdBps: 5_000,
      latestBlockhash: async () => ({ blockhash: RECENT_BLOCKHASH }),
      submitSignedTransaction: async () => {
        submitCalls += 1;
        if (submitCalls === 2) throw new Error('simulated second batch failure');
        return { txid: 'STREAM_TX_1', confirmedAt: '2026-05-16T12:01:00.000Z' };
      },
    });

    expect(result).toMatchObject({ settled: 1, failed: 1, skipped: 0 });
    const vouchers = await ctx.store.listVouchers(session.sessionId);
    expect(vouchers.filter((record) => record.settlementTxid === 'STREAM_TX_1')).toHaveLength(10);
    expect(vouchers.filter((record) => !record.settledAt)).toHaveLength(1);
    const receipts = await evidenceStore.listEvidence(WALLET);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.kind).toBe('streaming_settlement');
    expect(receipts[0]?.metadata?.sessionId).toBe(session.sessionId);
  });

  it('force-settles an active session before the cron threshold is reached', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const evidenceStore = new MemoryEvidenceStore();
    const session = await createActiveSession(ctx, {
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });
    await ctx.service.acceptVoucher({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      voucher: voucher(ctx.keypair, session.sessionId, 'nonce_force_settle', '0.05', recipient),
    });

    const result = await settleStreamingSession({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      streamingStore: ctx.store,
      evidenceStore,
      clock: ctx.clock,
      latestBlockhash: async () => ({ blockhash: RECENT_BLOCKHASH }),
      submitSignedTransaction: async () => ({ txid: 'STREAM_TX_FORCE', confirmedAt: '2026-05-16T12:01:00.000Z' }),
    });

    expect(result).toMatchObject({ settled: 1, failed: 0, skipped: 0 });
    expect(result.session?.status).toBe('active');
    expect(result.receipts).toHaveLength(1);
    const vouchers = await ctx.store.listVouchers(session.sessionId);
    expect(vouchers[0]?.settlementTxid).toBe('STREAM_TX_FORCE');
  });

  it('settles vouchers accepted before expiry even after new vouchers are blocked by expiry', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const evidenceStore = new MemoryEvidenceStore();
    const session = await createActiveSession(ctx, {
      capAmount: '1',
      expiresAt: '2026-05-16T12:10:00.000Z',
    });
    await ctx.service.acceptVoucher({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      voucher: voucher(ctx.keypair, session.sessionId, 'nonce_before_expiry', '0.05', recipient),
    });

    ctx.setNow('2026-05-16T12:11:00.000Z');
    await expectCode(
      ctx.service.acceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        voucher: voucher(ctx.keypair, session.sessionId, 'nonce_after_expiry', '0.05', recipient),
      }),
      'session_expired',
    );

    const result = await materializeStreamingSettlements({
      streamingStore: ctx.store,
      evidenceStore,
      clock: ctx.clock,
      latestBlockhash: async () => ({ blockhash: RECENT_BLOCKHASH }),
      submitSignedTransaction: async () => ({ txid: 'STREAM_TX_EXPIRED', confirmedAt: '2026-05-16T12:11:30.000Z' }),
    });

    expect(result).toMatchObject({ settled: 1, failed: 0, skipped: 0 });
    const vouchers = await ctx.store.listVouchers(session.sessionId);
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]?.settlementTxid).toBe('STREAM_TX_EXPIRED');
    const receipts = await evidenceStore.listEvidence(WALLET);
    expect(receipts[0]?.payload).toMatchObject({
      schema: 'streaming/settlement/0.1',
      sessionId: session.sessionId,
      txid: 'STREAM_TX_EXPIRED',
    });
  });
});

function createContext(input: { now: string }): {
  keypair: EphemeralKeypair;
  store: StreamingStore;
  service: StreamingService;
  clock: { now(): Date };
  setNow(now: string): void;
} {
  let now = new Date(input.now);
  let nextId = 0;
  const keypair = generateEphemeralKeypair();
  const store = new MemoryStreamingStore();
  const clock = { now: () => now };
  return {
    keypair,
    store,
    clock,
    setNow(value: string) {
      now = new Date(value);
    },
    service: new StreamingService(store, {
      clock,
      keypairFactory: () => keypair,
      idFactory: () => `test_${++nextId}`,
      latestBlockhash: async () => RECENT_BLOCKHASH,
    }),
  };
}

async function createActiveSession(
  ctx: ReturnType<typeof createContext>,
  input: {
    capAmount: string;
    expiresAt: string;
    recipientAllowlist?: readonly string[];
  },
): Promise<{ sessionId: string }> {
  const created = await ctx.service.createSession({
    walletAddress: WALLET,
    tokenMint: TOKEN_MINT,
    capAmount: input.capAmount,
    expiresAt: input.expiresAt,
    recipientAllowlist: input.recipientAllowlist,
    cluster: 'devnet',
  });
  await ctx.service.recordGrantSigned({
    walletAddress: WALLET,
    sessionId: created.session.sessionId,
    approveTxid: `APPROVE_${created.session.sessionId}`,
  });
  return { sessionId: created.session.sessionId };
}

function voucher(
  keypair: EphemeralKeypair,
  sessionId: string,
  nonce: string,
  amount: string,
  recipient: string,
  issuedAt = '2026-05-16T12:00:01.000Z',
): Voucher {
  return signVoucher(keypair, {
    sessionId,
    nonce,
    amount,
    recipient,
    issuedAt,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}
