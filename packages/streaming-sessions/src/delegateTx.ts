import {
  createApproveCheckedInstruction,
  createRevokeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import { StreamingInvalidInputError, StreamingNativeSolUnsupportedError } from './errors.js';
import { NATIVE_SOL_PSEUDO_MINT, type StreamingCluster, type Voucher, type VoucherHash } from './types.js';
import { computeVoucherHash, parseTokenAmountToBaseUnits, tokenDecimalsFor } from './voucher.js';

export const MAX_SETTLEMENT_VOUCHERS_PER_TX = 10;
export const SOLANA_PACKET_DATA_SIZE = 1232;
const BLOCKHASH_BYTES = 32;

export interface BuildApproveDelegateTxInput {
  ownerPubkey: string;
  tokenMint: string;
  delegatePubkey: string;
  capAmount?: string;
  amount?: string;
  tokenDecimals?: number;
  cluster: StreamingCluster;
  recentBlockhash: string;
  feePayerPubkey?: string;
  tokenProgramId?: string;
  allowOwnerOffCurve?: boolean;
  /**
   * Optional SOL pre-fund (in lamports) sent from owner → delegate as part
   * of the same approve tx. When set, the delegate pays its own settlement
   * fees instead of relying on a platform-funded fee payer.
   */
  delegatePrefundLamports?: number;
}

export interface BuildSweepDelegateTxInput {
  delegatePubkey: string;
  ownerPubkey: string;
  lamports: number;
  cluster: StreamingCluster;
  recentBlockhash: string;
}

export interface BuildRevokeDelegateTxInput {
  ownerPubkey: string;
  tokenMint: string;
  cluster: StreamingCluster;
  recentBlockhash: string;
  feePayerPubkey?: string;
  tokenProgramId?: string;
  allowOwnerOffCurve?: boolean;
}

export interface BuildSettlementTxInput {
  delegatePubkey: string;
  ownerPubkey: string;
  tokenMint: string;
  sourceAta?: string;
  feePayerPubkey: string;
  vouchers: readonly Voucher[];
  cluster: StreamingCluster;
  recentBlockhash: string;
  tokenDecimals?: number;
  tokenProgramId?: string;
  allowOwnerOffCurve?: boolean;
  /**
   * Phase 5.17 — optional override for the per-tx voucher count cap. Defaults
   * to {@link MAX_SETTLEMENT_VOUCHERS_PER_TX}. The settlement service reads
   * `STREAMING_MAX_VOUCHERS_PER_TX` and passes the value in here so operators
   * can tune throughput without redeploying the library.
   */
  maxVouchersPerTx?: number;
}

export type DelegateTxKind = 'approve_delegate' | 'revoke_delegate' | 'settlement' | 'sweep_delegate';

export interface UnsignedDelegateTx {
  txBase64: string;
  cluster: StreamingCluster;
  description: string;
  kind: DelegateTxKind;
  requiredSigners: readonly string[];
  tokenMint: string;
  tokenDecimals?: number;
  sourceAta?: string;
  destinationAtas?: readonly string[];
  voucherHashes?: readonly VoucherHash[];
  totalAmount?: string;
  instructionCount: number;
  serializedLength: number;
  batchIndex?: number;
  batchCount?: number;
}

interface BuiltUnsignedTx {
  txBase64: string;
  serializedLength: number;
}

interface PreparedSettlementTransfer {
  instruction: TransactionInstruction;
  voucher: Voucher;
  voucherHash: VoucherHash;
  amountBaseUnits: bigint;
  destinationAta: string;
}

export function buildApproveDelegateTx(input: BuildApproveDelegateTxInput): UnsignedDelegateTx {
  if (input.tokenMint === NATIVE_SOL_PSEUDO_MINT) {
    throw new StreamingNativeSolUnsupportedError();
  }
  const owner = publicKeyFromString(input.ownerPubkey, 'ownerPubkey');
  const mint = publicKeyFromString(input.tokenMint, 'tokenMint');
  const delegate = publicKeyFromString(input.delegatePubkey, 'delegatePubkey');
  const tokenProgramId = publicKeyFromString(input.tokenProgramId ?? TOKEN_PROGRAM_ID.toBase58(), 'tokenProgramId');
  const decimals = tokenDecimalsFor(input.tokenDecimals);
  const capAmount = resolveApproveAmount(input);
  const sourceAta = getAssociatedTokenAddressSync(mint, owner, input.allowOwnerOffCurve ?? false, tokenProgramId);
  const approveInstruction = createApproveCheckedInstruction(
    sourceAta,
    mint,
    delegate,
    owner,
    parseTokenAmountToBaseUnits(capAmount, decimals, { field: 'capAmount' }),
    decimals,
    [],
    tokenProgramId,
  );
  const prefundLamports = resolvePrefundLamports(input.delegatePrefundLamports);
  const instructions: TransactionInstruction[] = [];
  if (prefundLamports > 0) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: delegate,
        lamports: prefundLamports,
      }),
    );
  }
  instructions.push(approveInstruction);
  const feePayer = publicKeyFromString(input.feePayerPubkey ?? input.ownerPubkey, 'feePayerPubkey');
  const unsignedTx = buildUnsignedVersionedTx({
    feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions,
  });

  const description = prefundLamports > 0
    ? `Approve ${capAmount} tokens for streaming session delegate ${delegate.toBase58()} and pre-fund delegate with ${prefundLamports} lamports for settlement fees.`
    : `Approve ${capAmount} tokens for streaming session delegate ${delegate.toBase58()}.`;

  return {
    txBase64: unsignedTx.txBase64,
    cluster: input.cluster,
    description,
    kind: 'approve_delegate',
    requiredSigners: uniquePubkeys([feePayer, owner]),
    tokenMint: mint.toBase58(),
    tokenDecimals: decimals,
    sourceAta: sourceAta.toBase58(),
    totalAmount: capAmount,
    instructionCount: instructions.length,
    serializedLength: unsignedTx.serializedLength,
  };
}

export function buildSweepDelegateTx(input: BuildSweepDelegateTxInput): UnsignedDelegateTx {
  const delegate = publicKeyFromString(input.delegatePubkey, 'delegatePubkey');
  const owner = publicKeyFromString(input.ownerPubkey, 'ownerPubkey');
  const lamports = resolvePrefundLamports(input.lamports);
  if (lamports <= 0) {
    throw new StreamingInvalidInputError('lamports must be a positive integer to build a sweep tx.');
  }
  const instruction = SystemProgram.transfer({
    fromPubkey: delegate,
    toPubkey: owner,
    lamports,
  });
  const unsignedTx = buildUnsignedVersionedTx({
    feePayer: delegate,
    recentBlockhash: input.recentBlockhash,
    instructions: [instruction],
  });
  return {
    txBase64: unsignedTx.txBase64,
    cluster: input.cluster,
    description: `Sweep ${lamports} lamports from streaming session delegate ${delegate.toBase58()} back to owner ${owner.toBase58()}.`,
    kind: 'sweep_delegate',
    requiredSigners: uniquePubkeys([delegate]),
    tokenMint: '',
    instructionCount: 1,
    serializedLength: unsignedTx.serializedLength,
  };
}

function resolvePrefundLamports(value: number | undefined): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new StreamingInvalidInputError(
      `delegatePrefundLamports must be a non-negative integer; got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function buildRevokeDelegateTx(input: BuildRevokeDelegateTxInput): UnsignedDelegateTx {
  const owner = publicKeyFromString(input.ownerPubkey, 'ownerPubkey');
  const mint = publicKeyFromString(input.tokenMint, 'tokenMint');
  const tokenProgramId = publicKeyFromString(input.tokenProgramId ?? TOKEN_PROGRAM_ID.toBase58(), 'tokenProgramId');
  const sourceAta = getAssociatedTokenAddressSync(mint, owner, input.allowOwnerOffCurve ?? false, tokenProgramId);
  const instruction = createRevokeInstruction(sourceAta, owner, [], tokenProgramId);
  const feePayer = publicKeyFromString(input.feePayerPubkey ?? input.ownerPubkey, 'feePayerPubkey');
  const unsignedTx = buildUnsignedVersionedTx({
    feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions: [instruction],
  });

  return {
    txBase64: unsignedTx.txBase64,
    cluster: input.cluster,
    description: `Revoke streaming session delegate for ${sourceAta.toBase58()}.`,
    kind: 'revoke_delegate',
    requiredSigners: uniquePubkeys([feePayer, owner]),
    tokenMint: mint.toBase58(),
    sourceAta: sourceAta.toBase58(),
    instructionCount: 1,
    serializedLength: unsignedTx.serializedLength,
  };
}

export function buildSettlementTx(input: BuildSettlementTxInput): UnsignedDelegateTx[] {
  if (input.vouchers.length === 0) {
    throw new StreamingInvalidInputError('vouchers must contain at least one voucher.');
  }
  const delegate = publicKeyFromString(input.delegatePubkey, 'delegatePubkey');
  const owner = publicKeyFromString(input.ownerPubkey, 'ownerPubkey');
  const mint = publicKeyFromString(input.tokenMint, 'tokenMint');
  const feePayer = publicKeyFromString(input.feePayerPubkey, 'feePayerPubkey');
  const tokenProgramId = publicKeyFromString(input.tokenProgramId ?? TOKEN_PROGRAM_ID.toBase58(), 'tokenProgramId');
  const sourceAta = input.sourceAta
    ? publicKeyFromString(input.sourceAta, 'sourceAta')
    : getAssociatedTokenAddressSync(mint, owner, input.allowOwnerOffCurve ?? false, tokenProgramId);
  const decimals = tokenDecimalsFor(input.tokenDecimals);
  const firstSessionId = input.vouchers[0]?.sessionId;
  const preparedTransfers = input.vouchers.map((voucher, voucherIndex): PreparedSettlementTransfer => {
    if (voucher.sessionId !== firstSessionId) {
      throw new StreamingInvalidInputError('all settlement vouchers must use the same sessionId.');
    }
    const amountBaseUnits = parseTokenAmountToBaseUnits(voucher.amount, decimals, {
      field: `vouchers[${voucherIndex}].amount`,
    });
    const recipient = publicKeyFromString(voucher.recipient, `vouchers[${voucherIndex}].recipient`);
    const destinationAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      input.allowOwnerOffCurve ?? false,
      tokenProgramId,
    );
    const instruction = createTransferCheckedInstruction(
        sourceAta,
        mint,
        destinationAta,
        delegate,
        amountBaseUnits,
        decimals,
        [],
        tokenProgramId,
    );
    return {
      instruction,
      voucher,
      voucherHash: computeVoucherHash(voucher, { tokenDecimals: decimals }),
      amountBaseUnits,
      destinationAta: destinationAta.toBase58(),
    };
  });
  const batches = packSettlementTransfers({
    transfers: preparedTransfers,
    feePayer,
    recentBlockhash: input.recentBlockhash,
    maxVouchersPerTx: input.maxVouchersPerTx ?? MAX_SETTLEMENT_VOUCHERS_PER_TX,
  });

  return batches.map((batch, batchIndex) => {
    const totalBaseUnits = batch.transfers.reduce((sum, transfer) => sum + transfer.amountBaseUnits, 0n);
    const unsignedTx = buildUnsignedVersionedTx({
      feePayer,
      recentBlockhash: input.recentBlockhash,
      instructions: batch.transfers.map((transfer) => transfer.instruction),
    });

    return {
      txBase64: unsignedTx.txBase64,
      cluster: input.cluster,
      description: `Settle ${batch.transfers.length} streaming voucher${batch.transfers.length === 1 ? '' : 's'}.`,
      kind: 'settlement',
      requiredSigners: uniquePubkeys([feePayer, delegate]),
      tokenMint: mint.toBase58(),
      tokenDecimals: decimals,
      sourceAta: sourceAta.toBase58(),
      destinationAtas: batch.transfers.map((transfer) => transfer.destinationAta),
      voucherHashes: batch.transfers.map((transfer) => transfer.voucherHash),
      totalAmount: formatBaseUnitsForTx(totalBaseUnits, decimals),
      instructionCount: batch.transfers.length,
      serializedLength: unsignedTx.serializedLength,
      batchIndex,
      batchCount: batches.length,
    };
  });
}

function buildUnsignedVersionedTx(input: {
  feePayer: PublicKey;
  recentBlockhash: string;
  instructions: TransactionInstruction[];
}): BuiltUnsignedTx {
  const recentBlockhash = requireRecentBlockhash(input.recentBlockhash);
  const message = new TransactionMessage({
    payerKey: input.feePayer,
    recentBlockhash,
    instructions: input.instructions,
  }).compileToV0Message();
  const serialized = new VersionedTransaction(message).serialize();
  return {
    txBase64: bytesToBase64(serialized),
    serializedLength: serialized.length,
  };
}

function resolveApproveAmount(input: BuildApproveDelegateTxInput): string {
  if (input.capAmount === undefined && input.amount === undefined) {
    throw new StreamingInvalidInputError('capAmount is required.');
  }
  if (input.capAmount !== undefined && input.amount !== undefined && input.capAmount !== input.amount) {
    throw new StreamingInvalidInputError('capAmount and amount must match when both are provided.');
  }
  return input.capAmount ?? input.amount ?? '';
}

function requireRecentBlockhash(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StreamingInvalidInputError('recentBlockhash is required to build an unsigned transaction.');
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch (err) {
    throw new StreamingInvalidInputError(`recentBlockhash must be valid base58: ${(err as Error).message}`);
  }
  if (decoded.length !== BLOCKHASH_BYTES) {
    throw new StreamingInvalidInputError(`recentBlockhash must decode to ${BLOCKHASH_BYTES} bytes; got ${decoded.length}.`);
  }
  return value;
}

function publicKeyFromString(value: string, field: string): PublicKey {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StreamingInvalidInputError(`${field} must be a non-empty string.`);
  }
  try {
    return new PublicKey(value);
  } catch (err) {
    throw new StreamingInvalidInputError(`${field} must be a valid Solana public key: ${(err as Error).message}`);
  }
}

function packSettlementTransfers(input: {
  transfers: readonly PreparedSettlementTransfer[];
  feePayer: PublicKey;
  recentBlockhash: string;
  maxVouchersPerTx: number;
}): Array<{ transfers: PreparedSettlementTransfer[] }> {
  const batches: Array<{ transfers: PreparedSettlementTransfer[] }> = [];
  let current: PreparedSettlementTransfer[] = [];

  for (const transfer of input.transfers) {
    const candidate = [...current, transfer];
    const candidateTooLargeByCount = candidate.length > input.maxVouchersPerTx;
    const candidateTooLargeBySize = !candidateTooLargeByCount
      && serializedLengthForTransfers(candidate, input.feePayer, input.recentBlockhash) > SOLANA_PACKET_DATA_SIZE;

    if (candidateTooLargeByCount || candidateTooLargeBySize) {
      if (current.length === 0) {
        throw new StreamingInvalidInputError('single settlement voucher transaction exceeds Solana packet size.');
      }
      batches.push({ transfers: current });
      current = [transfer];
      if (serializedLengthForTransfers(current, input.feePayer, input.recentBlockhash) > SOLANA_PACKET_DATA_SIZE) {
        throw new StreamingInvalidInputError('single settlement voucher transaction exceeds Solana packet size.');
      }
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) {
    batches.push({ transfers: current });
  }
  return batches;
}

function serializedLengthForTransfers(
  transfers: readonly PreparedSettlementTransfer[],
  feePayer: PublicKey,
  recentBlockhash: string,
): number {
  return buildUnsignedVersionedTx({
    feePayer,
    recentBlockhash,
    instructions: transfers.map((transfer) => transfer.instruction),
  }).serializedLength;
}

function uniquePubkeys(pubkeys: readonly PublicKey[]): string[] {
  return [...new Set(pubkeys.map((pubkey) => pubkey.toBase58()))];
}

function bytesToBase64(bytes: Uint8Array): string {
  const btoaFn = (globalThis as { btoa?: (data: string) => string }).btoa;
  if (typeof btoaFn === 'function') {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoaFn(binary);
  }

  const bufferCtor = (globalThis as {
    Buffer?: { from(bytes: Uint8Array): { toString(encoding: 'base64'): string } };
  }).Buffer;
  if (bufferCtor) {
    return bufferCtor.from(bytes).toString('base64');
  }
  throw new StreamingInvalidInputError('No base64 encoder is available in this runtime.');
}

function formatBaseUnitsForTx(baseUnits: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const fraction = baseUnits % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}
