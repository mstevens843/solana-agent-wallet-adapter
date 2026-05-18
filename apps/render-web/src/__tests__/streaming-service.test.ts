import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  generateEphemeralKeypair,
  signVoucher,
  type EphemeralKeypair,
  type Voucher,
} from '@solana-agent-wallet-adapter/streaming-sessions';

import { MemoryEvidenceStore } from '../cloud/evidenceService.js';
import {
  __latestBlockhashForClusterForTests,
  materializeStreamingSettlements,
  settleStreamingSession,
} from '../cloud/settlementService.js';
import {
  decryptSessionDelegateKey,
  MemoryStreamingStore,
  StreamingService,
  __resetStreamingEncryptionKeyWarningForTests,
  streamingEncryptionKey,
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

  it('revoke prepares the transaction and confirmed revoke blocks later vouchers', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const session = await createActiveSession(ctx, {
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });

    const prepared = await ctx.service.revokeSession({ walletAddress: WALLET, sessionId: session.sessionId });
    expect(prepared.session.status).toBe('active');
    expect(prepared.revokeTx.kind).toBe('revoke_delegate');

    const submitted = await ctx.service.recordRevokeSigned({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      revokeTxid: `REVOKE_${session.sessionId}`,
      status: 'submitted',
    });
    expect(submitted.status).toBe('active');
    expect(submitted.metadata?.revokeTx).toMatchObject({
      txid: `REVOKE_${session.sessionId}`,
      status: 'submitted',
    });

    const revoked = await ctx.service.recordRevokeSigned({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      revokeTxid: `REVOKE_${session.sessionId}`,
      status: 'confirmed',
    });
    expect(revoked.status).toBe('revoked');

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
      // P5.9 — receipt payload now uses `settlementTxid` (the on-chain proof
      // pointer) instead of `signature: txid` (which was misleading because
      // verifiers expected an ed25519 sig).
      settlementTxid: 'STREAM_TX_EXPIRED',
    });
    expect(receipts[0]?.signature).toBe('');
    expect(receipts[0]?.metadata).toMatchObject({
      settlementTxid: 'STREAM_TX_EXPIRED',
    });
  });
});

describe('user-funded delegate (prefund + sweep)', () => {
  it('open-session approve tx pre-funds the delegate with a SystemProgram.transfer', async () => {
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const created = await ctx.service.createSession({
      walletAddress: WALLET,
      tokenMint: TOKEN_MINT,
      capAmount: '1',
      expiresAt: '2026-05-16T13:00:00.000Z',
      cluster: 'devnet',
    });
    // Default delegate prefund is 5_000_000 lamports (0.005 SOL). The tx must
    // carry two instructions: SystemProgram.transfer then SPL Approve.
    expect(created.approveTx.instructionCount).toBe(2);
    const versioned = VersionedTransaction.deserialize(
      Buffer.from(created.approveTx.txBase64, 'base64'),
    );
    const compiled = versioned.message.compiledInstructions;
    expect(compiled).toHaveLength(2);
    const firstProgramId = versioned.message.staticAccountKeys[compiled[0]!.programIdIndex]!.toBase58();
    expect(firstProgramId).toBe(SystemProgram.programId.toBase58());

    // Session metadata records the prefund amount for the cron's sweep logic.
    const stored = await ctx.store.getSession(WALLET, created.session.sessionId);
    expect(stored?.metadata?.delegatePrefundLamports).toBe(5_000_000);
  });

  it('honors STREAMING_DELEGATE_PREFUND_LAMPORTS env override', async () => {
    const original = process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS;
    process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS = '1234567';
    try {
      const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
      const created = await ctx.service.createSession({
        walletAddress: WALLET,
        tokenMint: TOKEN_MINT,
        capAmount: '1',
        expiresAt: '2026-05-16T13:00:00.000Z',
        cluster: 'devnet',
      });
      const stored = await ctx.store.getSession(WALLET, created.session.sessionId);
      expect(stored?.metadata?.delegatePrefundLamports).toBe(1234567);
      expect(created.approveTx.description).toContain('1234567 lamports');
    } finally {
      if (original === undefined) delete process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS;
      else process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS = original;
    }
  });

  it('sweeps residual delegate SOL back to owner when a session reaches terminal', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const evidenceStore = new MemoryEvidenceStore();
    const session = await createActiveSession(ctx, {
      capAmount: '0.05',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });
    // Single voucher exhausts the cap -> session becomes terminal after settle.
    await ctx.service.acceptVoucher({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      voucher: voucher(ctx.keypair, session.sessionId, 'nonce_terminal', '0.05', recipient),
    });

    const submitCalls: Array<{ kind: string; lamports?: number }> = [];
    const result = await materializeStreamingSettlements({
      streamingStore: ctx.store,
      evidenceStore,
      clock: ctx.clock,
      thresholdBps: 5_000,
      latestBlockhash: async () => ({ blockhash: RECENT_BLOCKHASH }),
      // Simulate the delegate having ~0.005 SOL residual after the settlement.
      lookupDelegateBalance: async () => 5_000_000,
      submitSignedTransaction: async (input) => {
        submitCalls.push({
          kind: input.unsignedTx.kind,
          ...(input.unsignedTx.kind === 'sweep_delegate' && typeof input.unsignedTx.serializedLength === 'number'
            ? { lamports: 5_000_000 - 5_000 }
            : {}),
        });
        return { txid: `TX_${submitCalls.length}`, confirmedAt: '2026-05-16T12:01:00.000Z' };
      },
    });

    expect(result.settled).toBe(1);
    // First submission is the settlement, second is the sweep.
    expect(submitCalls.map((call) => call.kind)).toEqual(['settlement', 'sweep_delegate']);
  });

  it('sweeps prefunded delegates for expired sessions with no vouchers', async () => {
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const evidenceStore = new MemoryEvidenceStore();
    const session = await createActiveSession(ctx, {
      capAmount: '0.05',
      expiresAt: '2026-05-16T12:30:00.000Z',
    });
    ctx.setNow('2026-05-16T12:31:00.000Z');

    const kinds: string[] = [];
    await materializeStreamingSettlements({
      streamingStore: ctx.store,
      evidenceStore,
      clock: ctx.clock,
      thresholdBps: 5_000,
      latestBlockhash: async () => ({ blockhash: RECENT_BLOCKHASH }),
      lookupDelegateBalance: async () => 5_000_000,
      submitSignedTransaction: async (input) => {
        kinds.push(input.unsignedTx.kind);
        return { txid: 'TX_SWEEP_ONLY', confirmedAt: '2026-05-16T12:31:10.000Z' };
      },
    });

    const stored = await ctx.store.getSession(WALLET, session.sessionId);
    expect(kinds).toEqual(['sweep_delegate']);
    expect(stored?.status).toBe('settled');
  });

  it('skips the sweep when residual balance is below the dust threshold', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const evidenceStore = new MemoryEvidenceStore();
    const session = await createActiveSession(ctx, {
      capAmount: '0.05',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });
    await ctx.service.acceptVoucher({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      voucher: voucher(ctx.keypair, session.sessionId, 'nonce_dust', '0.05', recipient),
    });

    const kinds: string[] = [];
    await materializeStreamingSettlements({
      streamingStore: ctx.store,
      evidenceStore,
      clock: ctx.clock,
      thresholdBps: 5_000,
      latestBlockhash: async () => ({ blockhash: RECENT_BLOCKHASH }),
      // Dust — below the 500_000 lamport sweep threshold.
      lookupDelegateBalance: async () => 100_000,
      submitSignedTransaction: async (input) => {
        kinds.push(input.unsignedTx.kind);
        return { txid: 'TX_DUST', confirmedAt: '2026-05-16T12:01:00.000Z' };
      },
    });
    // Only the settlement tx was submitted; no sweep follow-up.
    expect(kinds).toEqual(['settlement']);
  });

  it('does not sweep when the session was created with prefund disabled (0 lamports)', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const original = process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS;
    process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS = '0';
    try {
      const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
      const evidenceStore = new MemoryEvidenceStore();
      const session = await createActiveSession(ctx, {
        capAmount: '0.05',
        expiresAt: '2026-05-16T13:00:00.000Z',
      });
      const stored = await ctx.store.getSession(WALLET, session.sessionId);
      expect(stored?.metadata?.delegatePrefundLamports).toBeUndefined();

      await ctx.service.acceptVoucher({
        walletAddress: WALLET,
        sessionId: session.sessionId,
        voucher: voucher(ctx.keypair, session.sessionId, 'nonce_no_prefund', '0.05', recipient),
      });

      let balanceLookups = 0;
      const kinds: string[] = [];
      await materializeStreamingSettlements({
        streamingStore: ctx.store,
        evidenceStore,
        clock: ctx.clock,
        thresholdBps: 5_000,
        latestBlockhash: async () => ({ blockhash: RECENT_BLOCKHASH }),
        lookupDelegateBalance: async () => {
          balanceLookups += 1;
          return 5_000_000;
        },
        submitSignedTransaction: async (input) => {
          kinds.push(input.unsignedTx.kind);
          return { txid: 'TX_NO_PREFUND', confirmedAt: '2026-05-16T12:01:00.000Z' };
        },
      });
      expect(kinds).toEqual(['settlement']);
      expect(balanceLookups).toBe(0);
    } finally {
      if (original === undefined) delete process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS;
      else process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS = original;
    }
  });

  it('settlement failure does not propagate sweep errors', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const ctx = createContext({ now: '2026-05-16T12:00:00.000Z' });
    const evidenceStore = new MemoryEvidenceStore();
    const session = await createActiveSession(ctx, {
      capAmount: '0.05',
      expiresAt: '2026-05-16T13:00:00.000Z',
    });
    await ctx.service.acceptVoucher({
      walletAddress: WALLET,
      sessionId: session.sessionId,
      voucher: voucher(ctx.keypair, session.sessionId, 'nonce_sweep_fail', '0.05', recipient),
    });

    const result = await materializeStreamingSettlements({
      streamingStore: ctx.store,
      evidenceStore,
      clock: ctx.clock,
      thresholdBps: 5_000,
      latestBlockhash: async () => ({ blockhash: RECENT_BLOCKHASH }),
      lookupDelegateBalance: async () => 5_000_000,
      submitSignedTransaction: async (input) => {
        if (input.unsignedTx.kind === 'sweep_delegate') {
          throw new Error('simulated sweep RPC failure');
        }
        return { txid: 'TX_SETTLED', confirmedAt: '2026-05-16T12:01:00.000Z' };
      },
    });
    // Settlement succeeded; sweep error was logged but swallowed.
    expect(result).toMatchObject({ settled: 1, failed: 0 });
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

describe('latestBlockhashForCluster TEST_* env guard (P5.5)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_BLOCKHASH = process.env.STREAMING_TEST_RECENT_BLOCKHASH;
  function restore() {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_BLOCKHASH === undefined) delete process.env.STREAMING_TEST_RECENT_BLOCKHASH;
    else process.env.STREAMING_TEST_RECENT_BLOCKHASH = ORIGINAL_BLOCKHASH;
  }

  it('refuses to honor STREAMING_TEST_RECENT_BLOCKHASH outside NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STREAMING_TEST_RECENT_BLOCKHASH = 'FakeBlockHash11111111111111111111111111111111';
    try {
      await expect(__latestBlockhashForClusterForTests('devnet')).rejects.toThrowError(
        /NODE_ENV=test/,
      );
    } finally {
      restore();
    }
  });

  it('honors STREAMING_TEST_RECENT_BLOCKHASH inside NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    process.env.STREAMING_TEST_RECENT_BLOCKHASH = 'AcceptedTestBlockHash11111111111111111111111';
    try {
      const result = await __latestBlockhashForClusterForTests('devnet');
      expect(result.blockhash).toBe('AcceptedTestBlockHash11111111111111111111111');
    } finally {
      restore();
    }
  });
});

describe('streamingEncryptionKey (P5.2 hardening)', () => {
  const ORIGINAL = process.env.STREAMING_SESSION_ENCRYPTION_KEY;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  function restore() {
    if (ORIGINAL === undefined) delete process.env.STREAMING_SESSION_ENCRYPTION_KEY;
    else process.env.STREAMING_SESSION_ENCRYPTION_KEY = ORIGINAL;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    __resetStreamingEncryptionKeyWarningForTests();
  }

  it('refuses short passphrases that would silently SHA-256-downgrade entropy', () => {
    process.env.STREAMING_SESSION_ENCRYPTION_KEY = 'changeme';
    try {
      expect(() => streamingEncryptionKey()).toThrowError(/too weak|too short/i);
    } finally {
      restore();
    }
  });

  it('accepts a 32-byte raw base64 key verbatim with no entropy downgrade', () => {
    const raw = Buffer.alloc(32, 7);
    process.env.STREAMING_SESSION_ENCRYPTION_KEY = raw.toString('base64');
    try {
      const key = streamingEncryptionKey();
      expect(key.length).toBe(32);
      expect(key.equals(raw)).toBe(true);
    } finally {
      restore();
    }
  });

  it('accepts a >=32-char passphrase but warns once about the entropy downgrade', () => {
    process.env.STREAMING_SESSION_ENCRYPTION_KEY =
      'this-is-a-perfectly-acceptable-passphrase-of-sufficient-length';
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(typeof message === 'string' ? message : String(message));
    };
    try {
      const first = streamingEncryptionKey();
      const second = streamingEncryptionKey();
      expect(first.length).toBe(32);
      expect(first.equals(second)).toBe(true);
      expect(warnings.length).toBe(1); // only on first read
      expect(warnings[0]).toContain('SHA-256');
    } finally {
      console.warn = originalWarn;
      restore();
    }
  });
});
