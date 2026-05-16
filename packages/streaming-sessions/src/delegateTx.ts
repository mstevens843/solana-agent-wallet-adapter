import {
  createApproveCheckedInstruction,
  createRevokeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
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
}

export type DelegateTxKind = 'approve_delegate' | 'revoke_delegate' | 'settlement';

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
  const instruction = createApproveCheckedInstruction(
    sourceAta,
    mint,
    delegate,
    owner,
    parseTokenAmountToBaseUnits(capAmount, decimals, { field: 'capAmount' }),
    decimals,
    [],
    tokenProgramId,
  );
  const feePayer = publicKeyFromString(input.feePayerPubkey ?? input.ownerPubkey, 'feePayerPubkey');
  const unsignedTx = buildUnsignedVersionedTx({
    feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions: [instruction],
  });

  return {
    txBase64: unsignedTx.txBase64,
    cluster: input.cluster,
    description: `Approve ${capAmount} tokens for streaming session delegate ${delegate.toBase58()}.`,
    kind: 'approve_delegate',
    requiredSigners: uniquePubkeys([feePayer, owner]),
    tokenMint: mint.toBase58(),
    tokenDecimals: decimals,
    sourceAta: sourceAta.toBase58(),
    totalAmount: capAmount,
    instructionCount: 1,
    serializedLength: unsignedTx.serializedLength,
  };
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
}): Array<{ transfers: PreparedSettlementTransfer[] }> {
  const batches: Array<{ transfers: PreparedSettlementTransfer[] }> = [];
  let current: PreparedSettlementTransfer[] = [];

  for (const transfer of input.transfers) {
    const candidate = [...current, transfer];
    const candidateTooLargeByCount = candidate.length > MAX_SETTLEMENT_VOUCHERS_PER_TX;
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
