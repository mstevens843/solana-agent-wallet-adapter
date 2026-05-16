import { Buffer } from 'node:buffer';

import {
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  createRevokeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  SessionExpiredError,
  STREAMING_VOUCHER_SCHEMA,
  VoucherExceedsRemainingError,
  VoucherReplayError,
  VoucherRecipientNotAllowedError,
  buildApproveDelegateTx,
  buildRevokeDelegateTx,
  buildSettlementTx,
  canonicalize,
  computeVoucherHash,
  generateEphemeralKeypair,
  parseTokenAmountToBaseUnits,
  signVoucher,
  validateVoucher,
  verifyVoucher,
  type SessionGrant,
  type Voucher,
} from '../index.js';

describe('streaming-sessions voucher primitives', () => {
  it('signs and verifies a voucher with an ephemeral ed25519 keypair', () => {
    const keypair = generateEphemeralKeypair();
    const voucher = signVoucher(keypair, {
      sessionId: 'sess_123',
      nonce: 'nonce_1',
      amount: '0.05',
      recipient: Keypair.generate().publicKey.toBase58(),
      issuedAt: '2026-05-16T12:00:00.000Z',
    });

    expect(voucher.schema).toBe(STREAMING_VOUCHER_SCHEMA);
    expect(verifyVoucher(voucher, keypair.publicKey)).toBe(true);
    expect(verifyVoucher({ ...voucher, amount: '0.06' }, keypair.publicKey)).toBe(false);
    expect(verifyVoucher(voucher, Keypair.generate().publicKey.toBase58())).toBe(false);
  });

  it('computes deterministic voucher hashes from canonical JSON', () => {
    const keypair = generateEphemeralKeypair();
    const voucher = signVoucher(keypair, {
      sessionId: 'sess_hash',
      nonce: 'n',
      amount: '1.25',
      recipient: Keypair.generate().publicKey.toBase58(),
      issuedAt: '2026-05-16T12:00:00.000Z',
    });
    const reordered = {
      signature: voucher.signature,
      issuedAt: voucher.issuedAt,
      recipient: voucher.recipient,
      amount: voucher.amount,
      nonce: voucher.nonce,
      sessionId: voucher.sessionId,
      schema: voucher.schema,
    } as Voucher;

    expect(computeVoucherHash(reordered)).toBe(computeVoucherHash(voucher));
    expect(canonicalize({ b: 1, a: { d: true, c: null } })).toBe('{"a":{"c":null,"d":true},"b":1}');
  });

  it('detects replayed vouchers, expiry boundary, allowlist, and cap overflow', () => {
    const keypair = generateEphemeralKeypair();
    const recipient = Keypair.generate().publicKey.toBase58();
    const grant = sessionGrant({
      sessionId: 'sess_validate',
      ephemeralSignerPubkey: keypair.publicKey,
      recipientAllowlist: [recipient],
      capAmount: '1',
      spentAmount: '0.95',
      expiresAt: '2026-05-16T12:00:00.000Z',
    });
    const voucher = signVoucher(keypair, {
      sessionId: grant.sessionId,
      nonce: 'nonce_ok',
      amount: '0.05',
      recipient,
      issuedAt: '2026-05-16T11:59:00.000Z',
    });

    expect(
      validateVoucher({
        grant,
        voucher,
        now: '2026-05-16T11:59:59.999Z',
      }).remainingAmount,
    ).toBe('0');
    expect(() => validateVoucher({ grant, voucher, usedNonces: new Set([voucher.nonce]), now: '2026-05-16T11:59:00.000Z' })).toThrow(
      VoucherReplayError,
    );
    expect(() => validateVoucher({ grant, voucher, now: '2026-05-16T12:00:00.000Z' })).toThrow(SessionExpiredError);

    const blockedRecipientVoucher = signVoucher(keypair, {
      sessionId: grant.sessionId,
      nonce: 'nonce_blocked',
      amount: '0.01',
      recipient: Keypair.generate().publicKey.toBase58(),
      issuedAt: '2026-05-16T11:59:00.000Z',
    });
    expect(() => validateVoucher({ grant, voucher: blockedRecipientVoucher, now: '2026-05-16T11:59:00.000Z' })).toThrow(
      VoucherRecipientNotAllowedError,
    );

    const tooLargeVoucher = signVoucher(keypair, {
      sessionId: grant.sessionId,
      nonce: 'nonce_large',
      amount: '0.06',
      recipient,
      issuedAt: '2026-05-16T11:59:00.000Z',
    });
    expect(() => validateVoucher({ grant, voucher: tooLargeVoucher, now: '2026-05-16T11:59:00.000Z' })).toThrow(
      VoucherExceedsRemainingError,
    );
  });
});

describe('streaming-sessions delegate transaction builders', () => {
  it('builds ApproveChecked instruction data matching @solana/spl-token', () => {
    const owner = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const delegate = Keypair.generate().publicKey;
    const recentBlockhash = Keypair.generate().publicKey.toBase58();
    const tx = buildApproveDelegateTx({
      ownerPubkey: owner.publicKey.toBase58(),
      tokenMint: mint.toBase58(),
      delegatePubkey: delegate.toBase58(),
      capAmount: '10',
      tokenDecimals: 6,
      cluster: 'devnet',
      recentBlockhash,
    });
    const sourceAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
    const expected = createApproveCheckedInstruction(
      sourceAta,
      mint,
      delegate,
      owner.publicKey,
      parseTokenAmountToBaseUnits('10', 6),
      6,
    );

    expect(tx.kind).toBe('approve_delegate');
    expect(tx.sourceAta).toBe(sourceAta.toBase58());
    expect(firstInstructionData(tx.txBase64)).toEqual(Buffer.from(expected.data));
    expect(firstInstructionProgramId(tx.txBase64)).toBe(TOKEN_PROGRAM_ID.toBase58());
  });

  it('builds Revoke instruction data matching @solana/spl-token', () => {
    const owner = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const recentBlockhash = Keypair.generate().publicKey.toBase58();
    const tx = buildRevokeDelegateTx({
      ownerPubkey: owner.publicKey.toBase58(),
      tokenMint: mint.toBase58(),
      cluster: 'devnet',
      recentBlockhash,
    });
    const sourceAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
    const expected = createRevokeInstruction(sourceAta, owner.publicKey);

    expect(tx.kind).toBe('revoke_delegate');
    expect(tx.sourceAta).toBe(sourceAta.toBase58());
    expect(firstInstructionData(tx.txBase64)).toEqual(Buffer.from(expected.data));
    expect(firstInstructionProgramId(tx.txBase64)).toBe(TOKEN_PROGRAM_ID.toBase58());
  });

  it('builds batched TransferChecked settlement txs and chunks after 10 vouchers', () => {
    const owner = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const delegate = Keypair.generate();
    const feePayer = Keypair.generate();
    const sourceAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
    const recentBlockhash = Keypair.generate().publicKey.toBase58();
    const vouchers = Array.from({ length: 11 }, (_, index) =>
      signedVoucher({
        sessionId: 'sess_settle',
        nonce: `nonce_${index}`,
        amount: '0.05',
        recipient: Keypair.generate().publicKey.toBase58(),
      }),
    );

    const txs = buildSettlementTx({
      delegatePubkey: delegate.publicKey.toBase58(),
      ownerPubkey: owner.publicKey.toBase58(),
      tokenMint: mint.toBase58(),
      sourceAta: sourceAta.toBase58(),
      feePayerPubkey: feePayer.publicKey.toBase58(),
      vouchers,
      cluster: 'devnet',
      recentBlockhash,
      tokenDecimals: 6,
    });

    expect(txs).toHaveLength(2);
    expect(txs[0]?.instructionCount).toBe(10);
    expect(txs[0]?.totalAmount).toBe('0.5');
    expect(txs[1]?.instructionCount).toBe(1);
    expect(txs[1]?.totalAmount).toBe('0.05');

    const firstVoucher = vouchers[0] as Voucher;
    const expectedDestination = getAssociatedTokenAddressSync(mint, new PublicKey(firstVoucher.recipient));
    const expected = createTransferCheckedInstruction(
      sourceAta,
      mint,
      expectedDestination,
      delegate.publicKey,
      parseTokenAmountToBaseUnits(firstVoucher.amount, 6),
      6,
    );
    expect(firstInstructionData(txs[0]?.txBase64 ?? '')).toEqual(Buffer.from(expected.data));
    expect(firstInstructionProgramId(txs[0]?.txBase64 ?? '')).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});

function sessionGrant(overrides: Partial<SessionGrant>): SessionGrant {
  return {
    sessionId: 'sess_default',
    walletAddress: Keypair.generate().publicKey.toBase58(),
    cluster: 'devnet',
    tokenMint: Keypair.generate().publicKey.toBase58(),
    tokenDecimals: 6,
    delegatePubkey: Keypair.generate().publicKey.toBase58(),
    ephemeralSignerPubkey: Keypair.generate().publicKey.toBase58(),
    capAmount: '1',
    spentAmount: '0',
    expiresAt: '2026-05-16T12:00:00.000Z',
    status: 'active',
    createdAt: '2026-05-16T11:00:00.000Z',
    updatedAt: '2026-05-16T11:00:00.000Z',
    ...overrides,
  };
}

function signedVoucher(input: { sessionId: string; nonce: string; amount: string; recipient: string }): Voucher {
  const keypair = generateEphemeralKeypair();
  return signVoucher(keypair, {
    ...input,
    issuedAt: '2026-05-16T11:59:00.000Z',
  });
}

function firstInstructionData(txBase64: string): Buffer {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  const instruction = tx.message.compiledInstructions[0];
  if (!instruction) throw new Error('expected at least one compiled instruction');
  return Buffer.from(instruction.data);
}

function firstInstructionProgramId(txBase64: string): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  const instruction = tx.message.compiledInstructions[0];
  if (!instruction) throw new Error('expected at least one compiled instruction');
  return tx.message.staticAccountKeys[instruction.programIdIndex]?.toBase58() ?? '';
}
