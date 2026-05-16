import { createHash, randomUUID } from 'node:crypto';

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  STREAMING_SETTLEMENT_SCHEMA,
  buildSettlementTx,
  canonicalize,
  type StreamingCluster,
  type UnsignedDelegateTx,
  type Voucher,
} from '@solana-agent-wallet-adapter/streaming-sessions';
import type {
  EvidenceReceiptRecord,
  JsonObject,
} from '@solana-agent-wallet-adapter/workflow';

import { solanaRpcUrl } from './connectorFactsReader.js';
import type { EvidenceStore } from './evidenceService.js';
import {
  decryptSessionDelegateKey,
  publicSession,
  sessionHasServerDelegateKey,
  streamingStoreFor,
  StreamingServiceError,
  type StoredStreamingSession,
  type StreamingStore,
  type StreamingVoucherRecord,
} from './streamingService.js';
import type { Clock } from './store.js';

const DEFAULT_SETTLEMENT_THRESHOLD_BPS = 9_000;
const DEFAULT_CANDIDATE_LIMIT = 25;
const DEFAULT_LOCK_TTL_MS = 55_000;
const TEST_RECENT_BLOCKHASH_ENV = 'STREAMING_TEST_RECENT_BLOCKHASH';
const TEST_SETTLEMENT_TXID_ENV = 'STREAMING_TEST_SETTLEMENT_TXID';

export interface MaterializeStreamingSettlementsInput {
  store?: unknown;
  streamingStore?: StreamingStore;
  evidenceStore?: EvidenceStore;
  clock?: Clock;
  thresholdBps?: number;
  candidateLimit?: number;
  lockTtlMs?: number;
  latestBlockhash?: LatestSettlementBlockhashProvider;
  submitSignedTransaction?: StreamingSettlementSubmitter;
  feePayer?: Keypair;
}

export interface MaterializeStreamingSettlementsResult {
  settled: number;
  failed: number;
  skipped: number;
}

export interface SettleStreamingSessionInput extends MaterializeStreamingSettlementsInput {
  walletAddress: string;
  sessionId: string;
}

export interface SettleStreamingSessionResult extends MaterializeStreamingSettlementsResult {
  session?: StoredStreamingSession;
  receipts: EvidenceReceiptRecord[];
}

export interface LatestSettlementBlockhash {
  blockhash: string;
  lastValidBlockHeight?: number;
}

export interface LatestSettlementBlockhashProvider {
  (cluster: StreamingCluster): Promise<LatestSettlementBlockhash>;
}

export interface StreamingSettlementSubmitInput {
  cluster: StreamingCluster;
  signedTransactionBase64: string;
  unsignedTx: UnsignedDelegateTx;
  session: StoredStreamingSession;
  vouchers: readonly StreamingVoucherRecord[];
  blockhash: LatestSettlementBlockhash;
}

export interface StreamingSettlementSubmitter {
  (input: StreamingSettlementSubmitInput): Promise<{ txid: string; confirmedAt?: string }>;
}

interface SettlementExecutionContext {
  store: StreamingStore;
  evidenceStore: EvidenceStore;
  clock: Clock;
  latestBlockhash: LatestSettlementBlockhashProvider;
  submitSignedTransaction: StreamingSettlementSubmitter;
  feePayer?: Keypair;
}

interface SessionSettlementOutcome extends MaterializeStreamingSettlementsResult {
  receipts: EvidenceReceiptRecord[];
}

export async function materializeStreamingSettlements(
  input: MaterializeStreamingSettlementsInput = {},
): Promise<MaterializeStreamingSettlementsResult> {
  const clock = input.clock ?? { now: () => new Date() };
  const nowIso = clock.now().toISOString();
  const thresholdBps = input.thresholdBps ?? settlementThresholdBpsFromEnv();
  const limit = input.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const lockTtlMs = input.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const store = input.streamingStore ?? streamingStoreFor(input.store);
  const evidenceStore = input.evidenceStore ?? evidenceStoreFrom(input.store);
  const latestBlockhash = input.latestBlockhash ?? latestBlockhashForCluster;
  const submitSignedTransaction = input.submitSignedTransaction ?? defaultSubmitSignedTransaction;
  const feePayer = input.feePayer ?? settlementFeePayerFromEnv();
  const result: MaterializeStreamingSettlementsResult = { settled: 0, failed: 0, skipped: 0 };

  if (!evidenceStore) {
    return { settled: 0, failed: 0, skipped: 1 };
  }

  const candidates = await store.listSettlementCandidates(nowIso, thresholdBps, limit);
  const context: SettlementExecutionContext = {
    store,
    evidenceStore,
    clock,
    latestBlockhash,
    submitSignedTransaction,
    ...(feePayer ? { feePayer } : {}),
  };
  for (const candidate of candidates) {
    const lockExpiresAt = new Date(clock.now().getTime() + lockTtlMs).toISOString();
    const claimed = await store.claimSettlementCandidate(candidate.session.sessionId, clock.now().toISOString(), lockExpiresAt);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    addSettlementOutcome(result, await settleClaimedStreamingSession(context, claimed));
  }

  return result;
}

export async function settleStreamingSession(
  input: SettleStreamingSessionInput,
): Promise<SettleStreamingSessionResult> {
  const clock = input.clock ?? { now: () => new Date() };
  const lockTtlMs = input.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const store = input.streamingStore ?? streamingStoreFor(input.store);
  const evidenceStore = input.evidenceStore ?? evidenceStoreFrom(input.store);
  const latestBlockhash = input.latestBlockhash ?? latestBlockhashForCluster;
  const submitSignedTransaction = input.submitSignedTransaction ?? defaultSubmitSignedTransaction;
  const feePayer = input.feePayer ?? settlementFeePayerFromEnv();

  if (!evidenceStore) {
    return { settled: 0, failed: 0, skipped: 1, receipts: [] };
  }

  const session = await store.getSession(input.walletAddress, input.sessionId);
  if (!session) {
    throw new StreamingServiceError(404, 'session_not_found', `No streaming session found for id ${input.sessionId}.`);
  }
  const presented = publicSession(session, clock.now());
  if (presented.status === 'pending' || presented.status === 'settled') {
    return { settled: 0, failed: 0, skipped: 1, session: presented, receipts: [] };
  }
  if (!sessionHasServerDelegateKey(session)) {
    return { settled: 0, failed: 0, skipped: 1, session: presented, receipts: [] };
  }

  const nowIso = clock.now().toISOString();
  const lockExpiresAt = new Date(clock.now().getTime() + lockTtlMs).toISOString();
  const claimed = await store.claimSettlementCandidate(input.sessionId, nowIso, lockExpiresAt);
  if (!claimed) {
    return { settled: 0, failed: 0, skipped: 1, session: presented, receipts: [] };
  }

  const outcome = await settleClaimedStreamingSession({
    store,
    evidenceStore,
    clock,
    latestBlockhash,
    submitSignedTransaction,
    ...(feePayer ? { feePayer } : {}),
  }, claimed);
  const refreshed = await store.getSession(input.walletAddress, input.sessionId);
  return {
    settled: outcome.settled,
    failed: outcome.failed,
    skipped: outcome.skipped,
    session: publicSession(refreshed ?? claimed, clock.now()),
    receipts: outcome.receipts,
  };
}

async function settleClaimedStreamingSession(
  context: SettlementExecutionContext,
  claimed: StoredStreamingSession,
): Promise<SessionSettlementOutcome> {
  const receipts: EvidenceReceiptRecord[] = [];
  let anySettled = false;
  try {
    const unsettled = await context.store.listUnsettledVouchers(claimed.sessionId);
    if (unsettled.length === 0) {
      return { settled: 0, failed: 0, skipped: 1, receipts };
    }
    if (!sessionHasServerDelegateKey(claimed)) {
      return { settled: 0, failed: 0, skipped: 1, receipts };
    }
    const delegate = decryptSessionDelegateKey(claimed);
    const payer = context.feePayer ?? delegate;
    const blockhash = await context.latestBlockhash(claimed.cluster);
    const unsignedTxs = buildSettlementTx({
      delegatePubkey: claimed.delegatePubkey,
      ownerPubkey: claimed.walletAddress,
      tokenMint: claimed.tokenMint,
      feePayerPubkey: payer.publicKey.toBase58(),
      vouchers: unsettled.map((record) => record.voucher),
      cluster: claimed.cluster,
      recentBlockhash: blockhash.blockhash,
      tokenDecimals: claimed.tokenDecimals,
    });

    for (const unsignedTx of unsignedTxs) {
      const txVouchers = vouchersForUnsignedTx(unsettled, unsignedTx);
      if (txVouchers.length === 0) continue;
      const signedTransactionBase64 = signSettlementTx(unsignedTx, delegate, payer);
      const submitted = await context.submitSignedTransaction({
        cluster: claimed.cluster,
        signedTransactionBase64,
        unsignedTx,
        session: claimed,
        vouchers: txVouchers,
        blockhash,
      });
      const settledAt = submitted.confirmedAt ?? context.clock.now().toISOString();
      await context.store.markVouchersSettled(
        claimed.sessionId,
        txVouchers.map((record) => record.voucherHash),
        submitted.txid,
        settledAt,
      );
      const receipt = buildStreamingSettlementEvidence({
        session: claimed,
        vouchers: txVouchers,
        txid: submitted.txid,
        settledAt,
        totalAmount: unsignedTx.totalAmount ?? sumVoucherAmounts(txVouchers, claimed.tokenDecimals),
      });
      await context.evidenceStore.saveEvidence(claimed.walletAddress, receipt);
      await context.evidenceStore.appendEvidenceAuditEvent(claimed.walletAddress, {
        id: `audit_${randomUUID()}`,
        walletAddress: claimed.walletAddress,
        type: 'streaming.settlement.created',
        recordType: 'evidence',
        recordId: receipt.id,
        createdAt: settledAt,
        metadata: {
          sessionId: claimed.sessionId,
          txid: submitted.txid,
          receiptId: receipt.id,
          voucherCount: txVouchers.length,
        },
      });
      receipts.push(receipt);
      anySettled = true;
    }
    await context.store.markSessionSettledIfTerminal(claimed.sessionId, context.clock.now().toISOString());
    return {
      settled: anySettled ? 1 : 0,
      failed: 0,
      skipped: anySettled ? 0 : 1,
      receipts,
    };
  } catch (err) {
    console.warn(
      `[streaming-settlement] session=${claimed.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      settled: anySettled ? 1 : 0,
      failed: 1,
      skipped: 0,
      receipts,
    };
  }
}

function addSettlementOutcome(
  result: MaterializeStreamingSettlementsResult,
  outcome: MaterializeStreamingSettlementsResult,
): void {
  result.settled += outcome.settled;
  result.failed += outcome.failed;
  result.skipped += outcome.skipped;
}

function vouchersForUnsignedTx(
  vouchers: readonly StreamingVoucherRecord[],
  tx: UnsignedDelegateTx,
): StreamingVoucherRecord[] {
  const hashes = new Set(tx.voucherHashes ?? []);
  return vouchers.filter((record) => hashes.has(record.voucherHash));
}

function signSettlementTx(tx: UnsignedDelegateTx, delegate: Keypair, feePayer: Keypair): string {
  const transaction = VersionedTransaction.deserialize(Buffer.from(tx.txBase64, 'base64'));
  const signers = feePayer.publicKey.equals(delegate.publicKey) ? [delegate] : [feePayer, delegate];
  transaction.sign(signers);
  return Buffer.from(transaction.serialize()).toString('base64');
}

function buildStreamingSettlementEvidence(input: {
  session: StoredStreamingSession;
  vouchers: readonly StreamingVoucherRecord[];
  txid: string;
  settledAt: string;
  totalAmount: string;
}): EvidenceReceiptRecord {
  const payload: JsonObject = {
    schema: STREAMING_SETTLEMENT_SCHEMA,
    sessionId: input.session.sessionId,
    walletAddress: input.session.walletAddress,
    cluster: input.session.cluster,
    tokenMint: input.session.tokenMint,
    ...(input.session.tokenDecimals !== undefined ? { tokenDecimals: input.session.tokenDecimals } : {}),
    totalAmount: input.totalAmount,
    voucherCount: input.vouchers.length,
    voucherHashes: input.vouchers.map((record) => record.voucherHash),
    vouchers: input.vouchers.map((record) => voucherAsJson(record.voucher)),
    settledAt: input.settledAt,
    txid: input.txid,
  };
  const artifactHash = sha256Hex(payload);
  return {
    id: `evidence_streaming_${randomUUID()}`,
    walletAddress: input.session.walletAddress,
    cluster: input.session.cluster,
    title: `Streaming settlement: ${input.session.sessionId}`,
    kind: 'streaming_settlement',
    status: 'approved',
    payload,
    preSignatureHash: artifactHash,
    signingMessage: `streaming-settlement:${input.session.sessionId}@${input.txid}`,
    signature: input.txid,
    verified: true,
    artifactHash,
    createdAt: input.settledAt,
    updatedAt: input.settledAt,
    receiptType: 'streaming_settlement',
    summary: `Settled ${input.totalAmount} tokens across ${input.vouchers.length} streaming voucher${input.vouchers.length === 1 ? '' : 's'}.`,
    metadata: {
      sessionId: input.session.sessionId,
      txid: input.txid,
      tokenMint: input.session.tokenMint,
      voucherCount: input.vouchers.length,
      voucherHashes: input.vouchers.map((record) => record.voucherHash),
    },
  };
}

function voucherAsJson(voucher: Voucher): JsonObject {
  return {
    schema: voucher.schema,
    sessionId: voucher.sessionId,
    nonce: voucher.nonce,
    amount: voucher.amount,
    recipient: voucher.recipient,
    issuedAt: voucher.issuedAt,
    signature: voucher.signature,
  };
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function sumVoucherAmounts(vouchers: readonly StreamingVoucherRecord[], tokenDecimals = 6): string {
  let total = 0n;
  for (const voucher of vouchers) {
    const amount = voucher.amount;
    const [whole = '0', fraction = ''] = amount.split('.');
    const padded = fraction.padEnd(tokenDecimals, '0').slice(0, tokenDecimals);
    total += BigInt(whole) * (10n ** BigInt(tokenDecimals)) + BigInt(padded || '0');
  }
  const scale = 10n ** BigInt(tokenDecimals);
  const whole = total / scale;
  const fraction = total % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(tokenDecimals, '0').replace(/0+$/, '')}`;
}

function settlementThresholdBpsFromEnv(): number {
  const raw = Number(process.env.STREAMING_SETTLEMENT_THRESHOLD_BPS);
  return Number.isInteger(raw) && raw > 0 && raw <= 10_000 ? raw : DEFAULT_SETTLEMENT_THRESHOLD_BPS;
}

function latestBlockhashForCluster(cluster: StreamingCluster): Promise<LatestSettlementBlockhash> {
  const testBlockhash = process.env[TEST_RECENT_BLOCKHASH_ENV]?.trim();
  if (testBlockhash) return Promise.resolve({ blockhash: testBlockhash });
  return new Connection(solanaRpcUrl(cluster), 'confirmed').getLatestBlockhash('confirmed');
}

async function defaultSubmitSignedTransaction(input: StreamingSettlementSubmitInput): Promise<{ txid: string; confirmedAt?: string }> {
  const testTxid = process.env.NODE_ENV === 'test'
    ? process.env[TEST_SETTLEMENT_TXID_ENV]?.trim()
    : undefined;
  if (testTxid) {
    return { txid: testTxid, confirmedAt: new Date().toISOString() };
  }
  const connection = new Connection(solanaRpcUrl(input.cluster), 'confirmed');
  await verifySettlementDestinationAccounts(connection, input.unsignedTx.destinationAtas ?? []);
  const bytes = Buffer.from(input.signedTransactionBase64, 'base64');
  const txid = await connection.sendRawTransaction(bytes, {
    preflightCommitment: 'confirmed',
    maxRetries: 5,
  });
  const confirmation = await connection.confirmTransaction(txid, 'confirmed');
  if (confirmation.value.err) {
    throw new Error(`Settlement transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return { txid, confirmedAt: new Date().toISOString() };
}

async function verifySettlementDestinationAccounts(
  connection: Connection,
  destinationAtas: readonly string[],
): Promise<void> {
  if (destinationAtas.length === 0) return;
  const uniqueAtas = [...new Set(destinationAtas)];
  const accounts = await connection.getMultipleAccountsInfo(
    uniqueAtas.map((address) => new PublicKey(address)),
    'confirmed',
  );
  const missing = uniqueAtas.filter((address, index) => !accounts[index]);
  if (missing.length > 0) {
    throw new Error(`Settlement destination token account missing: ${missing.join(', ')}`);
  }
}

function settlementFeePayerFromEnv(): Keypair | undefined {
  const raw = process.env.STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY?.trim();
  if (!raw) return undefined;
  let bytes: Uint8Array;
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY JSON must be an array.');
    bytes = Uint8Array.from(parsed.map((entry) => Number(entry)));
  } else {
    bytes = Buffer.from(raw, 'base64');
  }
  return Keypair.fromSecretKey(bytes);
}

function evidenceStoreFrom(value: unknown): EvidenceStore | undefined {
  return isEvidenceStore(value) ? value : undefined;
}

function isEvidenceStore(value: unknown): value is EvidenceStore {
  return Boolean(value)
    && typeof (value as EvidenceStore).saveEvidence === 'function'
    && typeof (value as EvidenceStore).appendEvidenceAuditEvent === 'function'
    && typeof (value as EvidenceStore).listEvidence === 'function';
}
