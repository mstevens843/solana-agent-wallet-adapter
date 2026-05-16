import {
  createApproveCheckedInstruction,
  createRevokeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';

import { StreamingInvalidInputError } from './errors.js';
import { DEFAULT_TOKEN_DECIMALS, type StreamingCluster, type Voucher, type VoucherHash } from './types.js';
import { computeVoucherHash, parseTokenAmountToBaseUnits, tokenDecimalsFor } from './voucher.js';

const MAX_SETTLEMENT_VOUCHERS_PER_TX = 10;
const BLOCKHASH_BYTES = 32;

export interface BuildApproveDelegateTxInput {
  ownerPubkey: string;
  tokenMint: string;
  delegatePubkey: string;
  capAmount?: string;
  amount?: string;
  tokenDecimals?: number;
  cluster: StreamingCluster;
  recentBlockhash?: string;
  feePayerPubkey?: string;
  tokenProgramId?: string;
  allowOwnerOffCurve?: boolean;
}

export interface BuildRevokeDelegateTxInput {
  ownerPubkey: string;
  tokenMint: string;
  cluster: StreamingCluster;
  recentBlockhash?: string;
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
  recentBlockhash?: string;
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
  batchIndex?: number;
  batchCount?: number;
}

export function buildApproveDelegateTx(input: BuildApproveDelegateTxInput): UnsignedDelegateTx {
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
  const txBase64 = buildUnsignedVersionedTxBase64({
    feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions: [instruction],
  });

  return {
    txBase64,
    cluster: input.cluster,
    description: `Approve ${capAmount} tokens for streaming session delegate ${delegate.toBase58()}.`,
    kind: 'approve_delegate',
    requiredSigners: uniquePubkeys([feePayer, owner]),
    tokenMint: mint.toBase58(),
    tokenDecimals: decimals,
    sourceAta: sourceAta.toBase58(),
    totalAmount: capAmount,
    instructionCount: 1,
  };
}

export function buildRevokeDelegateTx(input: BuildRevokeDelegateTxInput): UnsignedDelegateTx {
  const owner = publicKeyFromString(input.ownerPubkey, 'ownerPubkey');
  const mint = publicKeyFromString(input.tokenMint, 'tokenMint');
  const tokenProgramId = publicKeyFromString(input.tokenProgramId ?? TOKEN_PROGRAM_ID.toBase58(), 'tokenProgramId');
  const sourceAta = getAssociatedTokenAddressSync(mint, owner, input.allowOwnerOffCurve ?? false, tokenProgramId);
  const instruction = createRevokeInstruction(sourceAta, owner, [], tokenProgramId);
  const feePayer = publicKeyFromString(input.feePayerPubkey ?? input.ownerPubkey, 'feePayerPubkey');
  const txBase64 = buildUnsignedVersionedTxBase64({
    feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions: [instruction],
  });

  return {
    txBase64,
    cluster: input.cluster,
    description: `Revoke streaming session delegate for ${sourceAta.toBase58()}.`,
    kind: 'revoke_delegate',
    requiredSigners: uniquePubkeys([feePayer, owner]),
    tokenMint: mint.toBase58(),
    sourceAta: sourceAta.toBase58(),
    instructionCount: 1,
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
  const batches = chunk(input.vouchers, MAX_SETTLEMENT_VOUCHERS_PER_TX);

  return batches.map((batch, batchIndex) => {
    let totalBaseUnits = 0n;
    const destinationAtas: string[] = [];
    const voucherHashes: VoucherHash[] = [];
    const instructions = batch.map((voucher, voucherIndex) => {
      if (voucher.sessionId !== input.vouchers[0]?.sessionId) {
        throw new StreamingInvalidInputError('all settlement vouchers must use the same sessionId.');
      }
      const amountBaseUnits = parseTokenAmountToBaseUnits(voucher.amount, decimals, {
        field: `vouchers[${batchIndex * MAX_SETTLEMENT_VOUCHERS_PER_TX + voucherIndex}].amount`,
      });
      totalBaseUnits += amountBaseUnits;
      const recipient = publicKeyFromString(
        voucher.recipient,
        `vouchers[${batchIndex * MAX_SETTLEMENT_VOUCHERS_PER_TX + voucherIndex}].recipient`,
      );
      const destinationAta = getAssociatedTokenAddressSync(
        mint,
        recipient,
        input.allowOwnerOffCurve ?? false,
        tokenProgramId,
      );
      destinationAtas.push(destinationAta.toBase58());
      voucherHashes.push(computeVoucherHash(voucher));
      return createTransferCheckedInstruction(
        sourceAta,
        mint,
        destinationAta,
        delegate,
        amountBaseUnits,
        decimals,
        [],
        tokenProgramId,
      );
    });

    const txBase64 = buildUnsignedVersionedTxBase64({
      feePayer,
      recentBlockhash: input.recentBlockhash,
      instructions,
    });

    return {
      txBase64,
      cluster: input.cluster,
      description: `Settle ${batch.length} streaming voucher${batch.length === 1 ? '' : 's'}.`,
      kind: 'settlement',
      requiredSigners: uniquePubkeys([feePayer, delegate]),
      tokenMint: mint.toBase58(),
      tokenDecimals: decimals,
      sourceAta: sourceAta.toBase58(),
      destinationAtas,
      voucherHashes,
      totalAmount: formatBaseUnitsForTx(totalBaseUnits, decimals),
      instructionCount: instructions.length,
      batchIndex,
      batchCount: batches.length,
    };
  });
}

function buildUnsignedVersionedTxBase64(input: {
  feePayer: PublicKey;
  recentBlockhash?: string;
  instructions: TransactionInstruction[];
}): string {
  const recentBlockhash = requireRecentBlockhash(input.recentBlockhash);
  const message = new TransactionMessage({
    payerKey: input.feePayer,
    recentBlockhash,
    instructions: input.instructions,
  }).compileToV0Message();
  return bytesToBase64(new VersionedTransaction(message).serialize());
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

function requireRecentBlockhash(value: string | undefined): string {
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

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
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
