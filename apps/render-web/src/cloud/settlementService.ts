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
  buildSweepDelegateTx,
  canonicalize,
  verifyVoucher,
  type StreamingCluster,
  type UnsignedDelegateTx,
  type Voucher,
} from '@solana-agent-wallet-adapter/streaming-sessions';
import {
  MPP_PAYMENT_RECEIPT_SCHEMA,
  buildMppPaymentReceipt,
  parseMppChallenge,
  toJsonObject,
  type MppChallenge,
  type MppCluster,
  type MppPaymentMethod,
  type MppReceipt,
} from '@solana-agent-wallet-adapter/mpp-adapter';
import type {
  ApprovalRequestRecord,
  EvidenceReceiptRecord,
  JsonObject,
} from '@solana-agent-wallet-adapter/workflow';

import bs58 from 'bs58';

import { solanaRpcUrl } from './connectorFactsReader.js';
import type { EvidenceStore } from './evidenceService.js';
import { redactSecrets } from './redaction.js';
import {
  decryptSessionDelegateKey,
  publicSession,
  sessionDelegatePrefundLamports,
  sessionHasServerDelegateKey,
  streamingStoreFor,
  StreamingServiceError,
  type LastSettlementAttempt,
  type StoredStreamingSession,
  type StreamingStore,
  type StreamingVoucherRecord,
} from './streamingService.js';
import type { Clock } from './store.js';

// Phase 5.4 — a previously-submitted settlement tx that hasn't reached
// confirmation yet stays "pending" on chain for ~150 slots (~60s). If the
// cron rebuilds before the prior tx is reconciled, the second tx wastes
// fee-payer SOL. We treat submissions older than RECONCILE_PENDING_HORIZON_MS
// as "stuck — assume dropped" and clear them so settlement can move on.
const RECONCILE_PENDING_HORIZON_MS = envInteger('STREAMING_RECONCILE_PENDING_HORIZON_MS', 180_000);
// Phase 5.4 — when a lookupSignatureStatus call says "still pending", we
// short-circuit the entire settle attempt to avoid double-submit. Wait this
// long before another cron tick treats the session as eligible again.
const HEARTBEAT_INTERVAL_MS = envInteger('STREAMING_HEARTBEAT_INTERVAL_MS', 30_000);

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`[streaming-settlement] env ${name}=${raw} is not a positive integer; using fallback ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function maxVouchersFromEnv(): number | undefined {
  const raw = process.env.STREAMING_MAX_VOUCHERS_PER_TX;
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[streaming-settlement] env STREAMING_MAX_VOUCHERS_PER_TX=${raw} is not a positive integer; falling back to library default.`,
    );
    return undefined;
  }
  return parsed;
}

// Phase 5.17 — defaults that operators can override via env vars without a
// redeploy. envInteger() is defined below to coerce + range-check.
const DEFAULT_SETTLEMENT_THRESHOLD_BPS = envInteger('STREAMING_SETTLEMENT_THRESHOLD_BPS_DEFAULT', 9_000);
const DEFAULT_CANDIDATE_LIMIT = envInteger('STREAMING_CANDIDATE_LIMIT', 25);
const DEFAULT_LOCK_TTL_MS = envInteger('STREAMING_LOCK_TTL_MS', 55_000);
const TEST_RECENT_BLOCKHASH_ENV = 'STREAMING_TEST_RECENT_BLOCKHASH';
const TEST_SETTLEMENT_TXID_ENV = 'STREAMING_TEST_SETTLEMENT_TXID';
const MPP_SESSION_PAYMENT_METADATA_KEY = 'mppSessionPayment';
const MPP_EVIDENCE_KIND = 'mpp_session';

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
  // Phase 5.4 — optional override; the default queries Solana RPC to reconcile
  // a session's `lastSettlementAttempt` before rebuilding a fresh tx.
  lookupSignatureStatus?: StreamingSettlementStatusLookup;
  // Reads the delegate's residual SOL balance so the cron can sweep it back
  // to the owner when a session reaches terminal state.
  lookupDelegateBalance?: StreamingDelegateBalanceLookup;
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

/**
 * Phase 5.4 — abstraction over `Connection.getSignatureStatus`. Returns the
 * confirmation status of a previously-submitted txid (or `unknown` if the RPC
 * doesn't recognize the signature, which usually means the tx was dropped
 * before landing in a leader's block).
 */
export type StreamingSettlementStatusOutcome =
  | { status: 'confirmed' | 'finalized'; confirmedAt?: string }
  | { status: 'pending' }
  | { status: 'failed'; error?: string }
  | { status: 'unknown' };

export interface StreamingSettlementStatusLookup {
  (cluster: StreamingCluster, txid: string): Promise<StreamingSettlementStatusOutcome>;
}

/**
 * Reads the SOL balance (in lamports) of an account. Injected so tests can
 * fake the RPC without hitting the network. The sweep-on-terminal path uses
 * this to decide whether the delegate has enough residual SOL to be worth
 * returning to the owner.
 */
export interface StreamingDelegateBalanceLookup {
  (cluster: StreamingCluster, pubkey: string): Promise<number>;
}

interface SettlementExecutionContext {
  store: StreamingStore;
  evidenceStore: EvidenceStore;
  workflowStore?: MppSessionPaymentApprovalStore;
  clock: Clock;
  latestBlockhash: LatestSettlementBlockhashProvider;
  submitSignedTransaction: StreamingSettlementSubmitter;
  lookupSignatureStatus: StreamingSettlementStatusLookup;
  lookupDelegateBalance: StreamingDelegateBalanceLookup;
  lockTtlMs: number;
  feePayer?: Keypair;
}

interface MppSessionPaymentApprovalStore {
  getApproval(walletAddress: string, id: string): Promise<ApprovalRequestRecord | undefined>;
  saveApproval(walletAddress: string, record: ApprovalRequestRecord): Promise<void>;
  appendAuditEvent?(
    walletAddress: string,
    record: {
      id: string;
      walletAddress: string;
      type: string;
      actor?: string;
      recordType?: string;
      recordId?: string;
      createdAt: string;
      metadata?: JsonObject;
    },
  ): Promise<void>;
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
  const workflowStore = mppApprovalStoreFrom(input.store);
  const latestBlockhash = input.latestBlockhash ?? latestBlockhashForCluster;
  const submitSignedTransaction = input.submitSignedTransaction ?? defaultSubmitSignedTransaction;
  const lookupSignatureStatus = input.lookupSignatureStatus ?? defaultLookupSignatureStatus;
  const lookupDelegateBalance = input.lookupDelegateBalance ?? defaultLookupDelegateBalance;
  // User-funded delegate model: no env-provided platform fee payer. Callers
  // (mostly tests) may still inject one explicitly via input.feePayer.
  const feePayer = input.feePayer;
  const result: MaterializeStreamingSettlementsResult = { settled: 0, failed: 0, skipped: 0 };

  if (!evidenceStore) {
    return { settled: 0, failed: 0, skipped: 1 };
  }

  const candidates = await store.listSettlementCandidates(nowIso, thresholdBps, limit);
  const context: SettlementExecutionContext = {
    store,
    evidenceStore,
    ...(workflowStore ? { workflowStore } : {}),
    clock,
    latestBlockhash,
    submitSignedTransaction,
    lookupSignatureStatus,
    lookupDelegateBalance,
    lockTtlMs,
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
  const workflowStore = mppApprovalStoreFrom(input.store);
  const latestBlockhash = input.latestBlockhash ?? latestBlockhashForCluster;
  const submitSignedTransaction = input.submitSignedTransaction ?? defaultSubmitSignedTransaction;
  const lookupSignatureStatus = input.lookupSignatureStatus ?? defaultLookupSignatureStatus;
  const lookupDelegateBalance = input.lookupDelegateBalance ?? defaultLookupDelegateBalance;
  // User-funded delegate model: no env-provided platform fee payer. Callers
  // (mostly tests) may still inject one explicitly via input.feePayer.
  const feePayer = input.feePayer;

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
    ...(workflowStore ? { workflowStore } : {}),
    clock,
    latestBlockhash,
    submitSignedTransaction,
    lookupSignatureStatus,
    lookupDelegateBalance,
    lockTtlMs,
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
  let currentSession = claimed;
  try {
    // Phase 5.4 — reconcile any prior settlement attempt against on-chain
    // state BEFORE building a fresh tx, so a retry doesn't double-submit
    // the same vouchers. Three outcomes:
    //   confirmed → mark the attempt's vouchers settled + clear attempt
    //   failed / unknown / expired → clear attempt + proceed normally
    //   still pending within horizon → short-circuit this run; let the
    //     network finalize before we try again next tick
    const reconcileOutcome = await reconcileLastSettlementAttempt(context, currentSession, receipts);
    if (reconcileOutcome.session) currentSession = reconcileOutcome.session;
    if (reconcileOutcome.skipRest) {
      return {
        settled: reconcileOutcome.settled,
        failed: 0,
        skipped: reconcileOutcome.settled === 0 ? 1 : 0,
        receipts,
      };
    }
    if (reconcileOutcome.settled > 0) anySettled = true;

    const unsettledRaw = await context.store.listUnsettledVouchers(currentSession.sessionId);
    // Phase 5.8 — re-verify every voucher signature against the session's
    // ephemeral signer pubkey BEFORE building the settlement tx. The voucher
    // signatures were verified at acceptance time, but a corrupted DB row or
    // a future bug could smuggle a forged voucher into the unsettled set.
    // Forged vouchers would be rejected on-chain (delegate cap / signature
    // semantics), but the on-chain reject burns fee-payer SOL and produces an
    // opaque error. Quarantining server-side gives operators a clear audit
    // event and isolates the bad voucher from a clean settlement of the rest.
    const unsettled = await partitionVerifiedVouchers(context, currentSession, unsettledRaw);
    if (unsettled.length === 0) {
      await context.store.markSessionSettledIfTerminal(
        currentSession.sessionId,
        context.clock.now().toISOString(),
      );
      await maybeSweepDelegate(context, currentSession);
      return {
        settled: anySettled ? 1 : 0,
        failed: 0,
        skipped: anySettled ? 0 : 1,
        receipts,
      };
    }
    if (!sessionHasServerDelegateKey(currentSession)) {
      return { settled: anySettled ? 1 : 0, failed: 0, skipped: 1, receipts };
    }
    const delegate = decryptSessionDelegateKey(currentSession);
    const payer = context.feePayer ?? delegate;
    const blockhash = await context.latestBlockhash(currentSession.cluster);
    const unsignedTxs = buildSettlementTx({
      delegatePubkey: currentSession.delegatePubkey,
      ownerPubkey: currentSession.walletAddress,
      tokenMint: currentSession.tokenMint,
      feePayerPubkey: payer.publicKey.toBase58(),
      vouchers: unsettled.map((record) => record.voucher),
      cluster: currentSession.cluster,
      recentBlockhash: blockhash.blockhash,
      tokenDecimals: currentSession.tokenDecimals,
      // Phase 5.17 — operator-tunable per-tx voucher chunk cap. Defaults to
      // the library's MAX_SETTLEMENT_VOUCHERS_PER_TX (10) if unset.
      ...(maxVouchersFromEnv() !== undefined ? { maxVouchersPerTx: maxVouchersFromEnv() } : {}),
    });

    for (let chunkIndex = 0; chunkIndex < unsignedTxs.length; chunkIndex += 1) {
      const unsignedTx = unsignedTxs[chunkIndex]!;
      const txVouchers = vouchersForUnsignedTx(unsettled, unsignedTx);
      if (txVouchers.length === 0) continue;

      // Phase 5.6 — between batches (when more than one chunk is in flight),
      // extend the settlement lock so a slow submit doesn't hand the lock to
      // a second worker mid-flight. We heartbeat BEFORE the next chunk
      // because the first chunk runs under the original claim's TTL.
      if (chunkIndex > 0) {
        const heartbeatNow = context.clock.now().toISOString();
        const newExpiry = new Date(context.clock.now().getTime() + context.lockTtlMs).toISOString();
        await context.store.heartbeatSettlementLock(currentSession.sessionId, heartbeatNow, newExpiry);
      }

      const signedTransactionBase64 = signSettlementTx(unsignedTx, delegate, payer);

      // Phase 5.4 — persist the attempted txid (first signature, base58)
      // BEFORE submitting so a crash between submit and confirm leaves a
      // breadcrumb the next reconcile can act on.
      const expectedTxid = deriveTxidFromSignedTransaction(signedTransactionBase64);
      const submittedAt = context.clock.now().toISOString();
      const updatedAfterAttempt = await context.store.setLastSettlementAttempt(
        currentSession.sessionId,
        {
          txid: expectedTxid,
          voucherHashes: txVouchers.map((record) => record.voucherHash),
          submittedAt,
        },
        submittedAt,
      );
      if (updatedAfterAttempt) currentSession = updatedAfterAttempt;

      const submitted = await context.submitSignedTransaction({
        cluster: currentSession.cluster,
        signedTransactionBase64,
        unsignedTx,
        session: currentSession,
        vouchers: txVouchers,
        blockhash,
      });
      const settledAt = submitted.confirmedAt ?? context.clock.now().toISOString();
      const settledVouchers = await context.store.markVouchersSettled(
        currentSession.sessionId,
        txVouchers.map((record) => record.voucherHash),
        submitted.txid,
        settledAt,
      );
      const receipt = buildStreamingSettlementEvidence({
        session: currentSession,
        vouchers: txVouchers,
        txid: submitted.txid,
        settledAt,
        totalAmount: unsignedTx.totalAmount ?? sumVoucherAmounts(txVouchers, currentSession.tokenDecimals),
      });
      await context.evidenceStore.saveEvidence(currentSession.walletAddress, receipt);
      await finalizeMppSessionPayments(
        context,
        currentSession,
        settledVouchers.length ? settledVouchers : txVouchers,
        submitted.txid,
        settledAt,
      );
      await context.evidenceStore.appendEvidenceAuditEvent(currentSession.walletAddress, {
        id: `audit_${randomUUID()}`,
        walletAddress: currentSession.walletAddress,
        type: 'streaming.settlement.created',
        recordType: 'evidence',
        recordId: receipt.id,
        createdAt: settledAt,
        metadata: {
          sessionId: currentSession.sessionId,
          txid: submitted.txid,
          receiptId: receipt.id,
          voucherCount: txVouchers.length,
        },
      });
      receipts.push(receipt);
      anySettled = true;

      // Phase 5.4 — confirmed; clear the breadcrumb so the next tick doesn't
      // think there's a pending attempt to reconcile.
      const clearedSession = await context.store.setLastSettlementAttempt(
        currentSession.sessionId,
        null,
        context.clock.now().toISOString(),
      );
      if (clearedSession) currentSession = clearedSession;
    }
    await context.store.markSessionSettledIfTerminal(currentSession.sessionId, context.clock.now().toISOString());
    await maybeSweepDelegate(context, currentSession);
    return {
      settled: anySettled ? 1 : 0,
      failed: 0,
      skipped: anySettled ? 0 : 1,
      receipts,
    };
  } catch (err) {
    // Phase 5.7 — redact secrets from the error message before logging. Solana
    // RPC errors can include partial base58 account data, and decrypt failures
    // can leak fragments of the encrypted delegate payload; both go through
    // redactSecrets to scrub anything that looks like a key, token, or JWT.
    const raw = err instanceof Error ? err.message : String(err);
    console.warn(
      `[streaming-settlement] session=${currentSession.sessionId} failed: ${redactSecrets(raw)}`,
    );
    return {
      settled: anySettled ? 1 : 0,
      failed: 1,
      skipped: 0,
      receipts,
    };
  }
}

/**
 * Phase 5.8 — separate verified vouchers from quarantine candidates. Forged
 * vouchers (signature doesn't match session.ephemeralSignerPubkey) are NOT
 * fed into buildSettlementTx; they remain `settled_at IS NULL` in the DB,
 * tagged with a `quarantined` audit event so operators can investigate.
 * Returns only the verified subset.
 */
async function partitionVerifiedVouchers(
  context: SettlementExecutionContext,
  session: StoredStreamingSession,
  unsettled: readonly StreamingVoucherRecord[],
): Promise<StreamingVoucherRecord[]> {
  const verified: StreamingVoucherRecord[] = [];
  for (const record of unsettled) {
    let valid = false;
    try {
      valid = verifyVoucher(record.voucher, session.ephemeralSignerPubkey, {
        tokenDecimals: session.tokenDecimals,
      });
    } catch {
      valid = false;
    }
    if (valid) {
      verified.push(record);
      continue;
    }
    // Forged or corrupted voucher — log an audit event so operators can
    // investigate. We deliberately don't mark the row settled (no on-chain
    // effect happened) and don't include it in the next settlement build.
    try {
      await context.evidenceStore.appendEvidenceAuditEvent(session.walletAddress, {
        id: `audit_${randomUUID()}`,
        walletAddress: session.walletAddress,
        type: 'streaming.voucher.quarantined',
        recordType: 'evidence',
        recordId: record.id,
        createdAt: context.clock.now().toISOString(),
        metadata: {
          sessionId: session.sessionId,
          voucherId: record.id,
          voucherHash: record.voucherHash,
          nonce: record.nonce,
          reason: 'invalid_signature',
        },
      });
    } catch (auditErr) {
      console.warn(
        `[streaming-settlement] session=${session.sessionId} voucher quarantine audit failed: ${redactSecrets(auditErr instanceof Error ? auditErr.message : String(auditErr))}`,
      );
    }
    console.warn(
      `[streaming-settlement] session=${session.sessionId} voucher ${record.id} quarantined (invalid signature)`,
    );
  }
  return verified;
}

/**
 * Phase 5.4 — reconcile a session's lastSettlementAttempt before rebuilding
 * a fresh tx. Returns either a `skipRest` flag (caller should bail and let
 * the network finalize) or `settled` count if a prior tx confirmed.
 */
async function reconcileLastSettlementAttempt(
  context: SettlementExecutionContext,
  claimed: StoredStreamingSession,
  receipts: EvidenceReceiptRecord[],
): Promise<{ skipRest: boolean; settled: number; session?: StoredStreamingSession }> {
  const prior = await context.store.getLastSettlementAttempt(claimed.sessionId);
  if (!prior) return { skipRest: false, settled: 0 };

  let status: StreamingSettlementStatusOutcome;
  try {
    status = await context.lookupSignatureStatus(claimed.cluster, prior.txid);
  } catch (err) {
    console.warn(
      `[streaming-settlement] session=${claimed.sessionId} reconcile lookup failed for txid=${prior.txid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { skipRest: false, settled: 0 };
  }

  if (status.status === 'confirmed' || status.status === 'finalized') {
    const settledAt = status.confirmedAt ?? context.clock.now().toISOString();
    const settled = await context.store.markVouchersSettled(
      claimed.sessionId,
      prior.voucherHashes,
      prior.txid,
      settledAt,
    );
    const cleared = await context.store.setLastSettlementAttempt(
      claimed.sessionId,
      null,
      context.clock.now().toISOString(),
    );
    if (settled.length === 0) {
      // The vouchers had already been marked (maybe by a different
      // reconcile or a manual mark) — nothing to receipt, just clear.
      return { skipRest: false, settled: 0, ...(cleared ? { session: cleared } : {}) };
    }
    const receipt = buildStreamingSettlementEvidence({
      session: cleared ?? claimed,
      vouchers: settled,
      txid: prior.txid,
      settledAt,
      totalAmount: sumVoucherAmounts(settled, claimed.tokenDecimals),
    });
    await context.evidenceStore.saveEvidence(claimed.walletAddress, receipt);
    await finalizeMppSessionPayments(context, cleared ?? claimed, settled, prior.txid, settledAt);
    await context.evidenceStore.appendEvidenceAuditEvent(claimed.walletAddress, {
      id: `audit_${randomUUID()}`,
      walletAddress: claimed.walletAddress,
      type: 'streaming.settlement.reconciled',
      recordType: 'evidence',
      recordId: receipt.id,
      createdAt: settledAt,
      metadata: {
        sessionId: claimed.sessionId,
        txid: prior.txid,
        receiptId: receipt.id,
        voucherCount: settled.length,
        source: 'lookup',
      },
    });
    receipts.push(receipt);
    return { skipRest: false, settled: 1, ...(cleared ? { session: cleared } : {}) };
  }

  if (status.status === 'pending') {
    const submittedAtMs = new Date(prior.submittedAt).getTime();
    const ageMs = context.clock.now().getTime() - submittedAtMs;
    if (Number.isFinite(submittedAtMs) && ageMs < RECONCILE_PENDING_HORIZON_MS) {
      // Still within the chain's window for this blockhash; give it more
      // time before submitting a fresh attempt that would race the old one.
      console.warn(
        `[streaming-settlement] session=${claimed.sessionId} prior tx ${prior.txid} still pending (age ${Math.round(ageMs / 1000)}s); short-circuiting this tick`,
      );
      return { skipRest: true, settled: 0 };
    }
    // Past the horizon — assume the tx was dropped before landing. Clear
    // the breadcrumb so a fresh attempt can run this tick.
  }

  // status === 'failed' | 'unknown', or pending past horizon. Clear so we
  // rebuild a fresh tx on this tick.
  const cleared = await context.store.setLastSettlementAttempt(
    claimed.sessionId,
    null,
    context.clock.now().toISOString(),
  );
  return { skipRest: false, settled: 0, ...(cleared ? { session: cleared } : {}) };
}

/**
 * The Solana convention: the canonical txid is the first signature of the
 * transaction, base58-encoded. We deserialize the signed bytes and read it
 * out so we can persist it as the "expected txid" before submitting, even if
 * the RPC submission throws.
 */
function deriveTxidFromSignedTransaction(signedTransactionBase64: string): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(signedTransactionBase64, 'base64'));
  const firstSignature = tx.signatures[0];
  if (!firstSignature) {
    throw new Error('Signed settlement transaction has no signatures; cannot derive txid.');
  }
  return bs58.encode(firstSignature);
}

async function defaultLookupSignatureStatus(
  cluster: StreamingCluster,
  txid: string,
): Promise<StreamingSettlementStatusOutcome> {
  const connection = new Connection(solanaRpcUrl(cluster), 'confirmed');
  const status = await connection.getSignatureStatus(txid, { searchTransactionHistory: true });
  const value = status.value;
  if (!value) return { status: 'unknown' };
  if (value.err) {
    return { status: 'failed', error: JSON.stringify(value.err) };
  }
  const commitment = value.confirmationStatus;
  if (commitment === 'finalized') return { status: 'finalized' };
  if (commitment === 'confirmed') return { status: 'confirmed' };
  // processed or null → still pending
  return { status: 'pending' };
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
    settlementTxid: input.txid,
  };
  const artifactHash = sha256Hex(payload);
  // Phase 5.9 — receipt-semantics fix. The previous shape set
  // `signature: txid`, which is structurally a Solana transaction hash, NOT
  // an ed25519 signature. Verifiers expecting `signature` to be a crypto
  // proof would silently accept the txid. The fix is two-fold:
  //   1. `signature` is now empty: the render-web cron does NOT sign these
  //      receipts (no server signing key today). They are audit-trail
  //      records, not wallet-signed proofs.
  //   2. The proof is the on-chain settlement transaction itself. Its txid
  //      is surfaced as `metadata.settlementTxid` (machine-readable) and in
  //      the summary (human-readable). Anyone can independently verify the
  //      settlement by looking the txid up on Solana.
  const recipientSet = new Set(input.vouchers.map((record) => record.voucher.recipient));
  const recipientList = (() => {
    const recipients = [...recipientSet];
    if (recipients.length === 1) return `to ${recipients[0]}`;
    if (recipients.length <= 3) return `to ${recipients.join(', ')}`;
    return `to ${recipients.length} recipients`;
  })();
  return {
    id: `evidence_streaming_${randomUUID()}`,
    walletAddress: input.session.walletAddress,
    cluster: input.session.cluster,
    title: `Streaming settlement: ${input.session.sessionId}`,
    kind: 'streaming_settlement',
    status: 'approved',
    payload,
    preSignatureHash: artifactHash,
    signingMessage:
      `streaming-settlement:${input.session.sessionId} settled ${input.vouchers.length} voucher${input.vouchers.length === 1 ? '' : 's'} ${recipientList} via on-chain tx ${input.txid}. This receipt is an audit-trail record, not a cryptographic signature; verify the settlement by looking up the txid on Solana.`,
    signature: '',
    verified: true,
    artifactHash,
    createdAt: input.settledAt,
    updatedAt: input.settledAt,
    receiptType: 'streaming_settlement',
    summary:
      `Settled ${input.totalAmount} tokens ${recipientList} across ${input.vouchers.length} streaming voucher${input.vouchers.length === 1 ? '' : 's'}. Proof: on-chain tx ${input.txid}.`,
    metadata: {
      sessionId: input.session.sessionId,
      settlementTxid: input.txid,
      // Keep `txid` for one release as an alias for legacy consumers (the
      // Phase 0–2 evidence UIs read this key). Future v1.1 work can drop it.
      txid: input.txid,
      tokenMint: input.session.tokenMint,
      voucherCount: input.vouchers.length,
      voucherHashes: input.vouchers.map((record) => record.voucherHash),
    },
  };
}

async function finalizeMppSessionPayments(
  context: SettlementExecutionContext,
  session: StoredStreamingSession,
  vouchers: readonly StreamingVoucherRecord[],
  txid: string,
  settledAt: string,
): Promise<void> {
  for (const voucher of vouchers) {
    const metadata = objectRecord(voucher.metadata);
    const sessionPayment = objectRecord(metadata?.[MPP_SESSION_PAYMENT_METADATA_KEY]);
    if (sessionPayment?.finality !== 'settlement_confirmed') continue;
    const approvalId = stringValue(sessionPayment.approvalId);
    if (!approvalId) continue;

    let challenge: MppChallenge;
    try {
      challenge = parseMppChallenge(metadata?.mppChallenge);
    } catch (err) {
      console.warn(
        `[streaming-settlement] session=${session.sessionId} voucher=${voucher.id} MPP settlement finality skipped: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
      );
      continue;
    }
    const paymentMethod = paymentMethodFromMetadata(metadata?.mppPaymentMethod, challenge);
    if (!paymentMethod) continue;

    const issuedAt = context.clock.now().toISOString();
    const receipt = buildMppPaymentReceipt({
      challenge,
      credential: {
        kind: paymentMethod.kind,
        signature: txid,
        txid,
        payerWallet: session.walletAddress,
        settledAt,
      },
      walletAddress: session.walletAddress,
      cluster: session.cluster as MppCluster,
      txid,
      settledAt,
      issuedAt,
      paymentMethod,
    });
    const evidence = buildMppSessionSettlementEvidence({
      session,
      voucher,
      approvalId,
      receipt,
      issuedAt,
    });
    await context.evidenceStore.saveEvidence(session.walletAddress, evidence);
    await context.evidenceStore.appendEvidenceAuditEvent(session.walletAddress, {
      id: `audit_${randomUUID()}`,
      walletAddress: session.walletAddress,
      type: 'mpp.session_payment.settlement_confirmed',
      recordType: 'evidence',
      recordId: evidence.id,
      createdAt: issuedAt,
      metadata: {
        approvalId,
        sessionId: session.sessionId,
        voucherId: voucher.id,
        voucherHash: voucher.voucherHash,
        txid,
        receiptId: receipt.receiptId,
        receiptHash: receipt.artifactHash,
        challengeHash: receipt.challengeHash,
      },
    });

    const workflowStore = context.workflowStore;
    if (!workflowStore) continue;
    const approval = await workflowStore.getApproval(session.walletAddress, approvalId);
    if (!approval) continue;
    const updatedLink: JsonObject = {
      ...jsonObjectValue(approval.metadata?.[MPP_SESSION_PAYMENT_METADATA_KEY]),
      approvalId,
      challengeHash: receipt.challengeHash,
      sessionId: session.sessionId,
      voucherId: voucher.id,
      voucherHash: voucher.voucherHash,
      amount: voucher.amount,
      recipient: voucher.recipient,
      tokenMint: session.tokenMint,
      cluster: session.cluster,
      finality: 'settlement_confirmed',
      status: 'settlement_confirmed',
      createdAt: stringValue(sessionPayment.createdAt) ?? voucher.createdAt,
      updatedAt: issuedAt,
      settledAt,
      settlementTxid: txid,
      receiptId: evidence.id,
      receiptHash: receipt.artifactHash,
    };
    await workflowStore.saveApproval(session.walletAddress, {
      ...approval,
      status: 'approved',
      txid,
      txStatus: 'confirmed',
      updatedAt: issuedAt,
      decidedAt: approval.decidedAt ?? settledAt,
      confirmedAt: settledAt,
      metadata: {
        ...(approval.metadata ?? {}),
        [MPP_SESSION_PAYMENT_METADATA_KEY]: updatedLink,
        mppPaymentReceipt: toJsonObject(receipt),
        mppPaymentReceiptIssuedAt: issuedAt,
        mppEvidenceReceiptId: evidence.id,
      },
    });
    await workflowStore.appendAuditEvent?.(session.walletAddress, {
      id: `audit_${randomUUID()}`,
      walletAddress: session.walletAddress,
      type: 'mpp.session_payment.approval_confirmed',
      actor: 'server',
      recordType: 'approval',
      recordId: approvalId,
      createdAt: issuedAt,
      metadata: {
        approvalId,
        sessionId: session.sessionId,
        voucherId: voucher.id,
        txid,
        receiptId: evidence.id,
        receiptHash: receipt.artifactHash,
      },
    });
  }
}

function buildMppSessionSettlementEvidence(input: {
  session: StoredStreamingSession;
  voucher: StreamingVoucherRecord;
  approvalId: string;
  receipt: MppReceipt;
  issuedAt: string;
}): EvidenceReceiptRecord {
  const merchant = input.receipt.merchant?.name ?? input.receipt.merchant?.id ?? input.receipt.recipient;
  return {
    id: `evidence_mpp_${randomUUID()}`,
    walletAddress: input.session.walletAddress,
    cluster: input.session.cluster,
    title: `MPP Session Payment: ${merchant}`,
    kind: MPP_EVIDENCE_KIND,
    status: 'approved',
    payload: toJsonObject(input.receipt),
    preSignatureHash: input.receipt.artifactHash,
    signingMessage: `mpp-session-payment:${input.approvalId}:${input.voucher.voucherHash}@${input.receipt.txid ?? input.receipt.credentialHash}`,
    signature: input.receipt.txid ?? input.receipt.credentialHash,
    verified: true,
    artifactHash: input.receipt.artifactHash,
    createdAt: input.issuedAt,
    updatedAt: input.issuedAt,
    receiptType: MPP_PAYMENT_RECEIPT_SCHEMA,
    summary: `Settled ${input.receipt.amount} ${input.receipt.currency} to ${merchant} via an MPP streaming-session voucher.`,
    metadata: {
      approvalId: input.approvalId,
      sessionId: input.session.sessionId,
      voucherId: input.voucher.id,
      voucherHash: input.voucher.voucherHash,
      txid: input.receipt.txid ?? '',
      receiptId: input.receipt.receiptId,
      receiptHash: input.receipt.artifactHash,
      challengeHash: input.receipt.challengeHash,
      nonce: input.receipt.nonce,
      resourceUrl: input.receipt.resourceUrl,
      finality: 'settlement_confirmed',
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
  // Phase 5.17 — STREAMING_SETTLEMENT_THRESHOLD_BPS overrides the per-tick
  // threshold (default 9000 bps = 90% of cap). Must be in [1, 10000].
  const raw = Number(process.env.STREAMING_SETTLEMENT_THRESHOLD_BPS);
  return Number.isInteger(raw) && raw > 0 && raw <= 10_000 ? raw : DEFAULT_SETTLEMENT_THRESHOLD_BPS;
}

async function latestBlockhashForCluster(cluster: StreamingCluster): Promise<LatestSettlementBlockhash> {
  const testBlockhash = process.env[TEST_RECENT_BLOCKHASH_ENV]?.trim();
  if (testBlockhash) {
    // Phase 5.5 — refuse to honor the test override in any non-test runtime so
    // a stray production env doesn't silently fake the blockhash and bypass
    // the real-RPC code path. Operators who legitimately need a mock RPC must
    // explicitly run with NODE_ENV=test.
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        `${TEST_RECENT_BLOCKHASH_ENV} is set outside NODE_ENV=test. Refusing to fake the recent blockhash in production-like environments.`,
      );
    }
    return { blockhash: testBlockhash };
  }
  return new Connection(solanaRpcUrl(cluster), 'confirmed').getLatestBlockhash('confirmed');
}

async function defaultSubmitSignedTransaction(input: StreamingSettlementSubmitInput): Promise<{ txid: string; confirmedAt?: string }> {
  // Phase 5.5 — the production-mode guard was already in place for
  // STREAMING_TEST_SETTLEMENT_TXID via the NODE_ENV check below, but we
  // upgrade to an explicit refusal so a misconfigured env var fails loudly
  // instead of silently disabling itself.
  const testTxidRaw = process.env[TEST_SETTLEMENT_TXID_ENV]?.trim();
  if (testTxidRaw && process.env.NODE_ENV !== 'test') {
    throw new Error(
      `${TEST_SETTLEMENT_TXID_ENV} is set outside NODE_ENV=test. Refusing to fake settlement transactions in production-like environments.`,
    );
  }
  const testTxid = process.env.NODE_ENV === 'test' ? testTxidRaw : undefined;
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

// Test-only re-exports. Public API stays narrow; tests opt in by importing the
// `__*ForTests` aliases below so the production-surface footprint is unchanged.
export const __latestBlockhashForClusterForTests = (cluster: StreamingCluster) =>
  latestBlockhashForCluster(cluster);

// As of 2026-05-16 the platform-funded fee-payer env var
// (STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY) was removed. Streaming sessions
// now pre-fund their own ephemeral delegate keypair at session-open time, and
// the settlement cron signs settlement txs with that delegate (no shared
// operator wallet). See:
//   - streamingService.ts → delegatePrefundLamportsFromEnv()
//   - delegateTx.ts → buildSweepDelegateTx()
//   - maybeSweepDelegate() below

// Minimum lamports we'll bother sweeping back to the owner. Anything smaller
// nets out negative (or rounds to dust) once the 5_000 lamport tx fee is paid.
const SWEEP_MIN_LAMPORTS = 500_000;
const SWEEP_TX_FEE_LAMPORTS = 5_000;

async function maybeSweepDelegate(
  context: SettlementExecutionContext,
  session: StoredStreamingSession,
): Promise<void> {
  try {
    // Re-fetch to get the latest status (markSessionSettledIfTerminal may
    // have flipped status='settled' after the prior call).
    const latest = await context.store.getSession(session.walletAddress, session.sessionId);
    const candidate = latest ?? session;
    const status = candidate.status;
    const isTerminal = status === 'settled' || status === 'revoked' || status === 'expired';
    if (!isTerminal) return;
    if (!sessionHasServerDelegateKey(candidate)) return;
    // If this session never had a server-side prefund, the delegate has zero
    // SOL and there's nothing to sweep. Cheap short-circuit avoids one RPC.
    if (sessionDelegatePrefundLamports(candidate) === 0) return;

    const delegate = decryptSessionDelegateKey(candidate);
    const balance = await context.lookupDelegateBalance(candidate.cluster, delegate.publicKey.toBase58());
    if (!Number.isFinite(balance) || balance <= SWEEP_MIN_LAMPORTS) return;

    const sweepLamports = balance - SWEEP_TX_FEE_LAMPORTS;
    if (sweepLamports <= 0) return;

    const blockhash = await context.latestBlockhash(candidate.cluster);
    const sweepTx = buildSweepDelegateTx({
      delegatePubkey: delegate.publicKey.toBase58(),
      ownerPubkey: candidate.walletAddress,
      lamports: sweepLamports,
      cluster: candidate.cluster,
      recentBlockhash: blockhash.blockhash,
    });
    const transaction = VersionedTransaction.deserialize(Buffer.from(sweepTx.txBase64, 'base64'));
    transaction.sign([delegate]);
    const signedBase64 = Buffer.from(transaction.serialize()).toString('base64');
    const submitted = await context.submitSignedTransaction({
      cluster: candidate.cluster,
      signedTransactionBase64: signedBase64,
      unsignedTx: sweepTx,
      session: candidate,
      vouchers: [],
      blockhash,
    });
    console.info(
      `[streaming-settlement] session=${candidate.sessionId} swept ${sweepLamports} lamports from delegate ${delegate.publicKey.toBase58()} → owner ${candidate.walletAddress} (txid=${submitted.txid})`,
    );
  } catch (err) {
    // Sweep is best-effort. Failure must NEVER bubble up — settlement
    // bookkeeping is already done and the dust can be recovered on a later
    // cron tick or manually.
    const raw = err instanceof Error ? err.message : String(err);
    console.warn(
      `[streaming-settlement] session=${session.sessionId} sweep failed: ${redactSecrets(raw)}`,
    );
  }
}

async function defaultLookupDelegateBalance(
  cluster: StreamingCluster,
  pubkey: string,
): Promise<number> {
  const connection = new Connection(solanaRpcUrl(cluster), 'confirmed');
  return connection.getBalance(new PublicKey(pubkey), 'confirmed');
}

function evidenceStoreFrom(value: unknown): EvidenceStore | undefined {
  return isEvidenceStore(value) ? value : undefined;
}

function mppApprovalStoreFrom(value: unknown): MppSessionPaymentApprovalStore | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<MppSessionPaymentApprovalStore>;
  if (typeof record.getApproval !== 'function' || typeof record.saveApproval !== 'function') {
    return undefined;
  }
  return value as MppSessionPaymentApprovalStore;
}

function isEvidenceStore(value: unknown): value is EvidenceStore {
  return Boolean(value)
    && typeof (value as EvidenceStore).saveEvidence === 'function'
    && typeof (value as EvidenceStore).appendEvidenceAuditEvent === 'function'
    && typeof (value as EvidenceStore).listEvidence === 'function';
}

function paymentMethodFromMetadata(value: unknown, challenge: MppChallenge): MppPaymentMethod | undefined {
  const record = objectRecord(value);
  const kind = record ? stringValue(record.kind) : undefined;
  const recipient = record ? stringValue(record.recipient) : undefined;
  const network = record ? stringValue(record.network) : undefined;
  const mint = record ? stringValue(record.mint) : undefined;
  const exact = challenge.paymentMethods.find((candidate) =>
    candidate.kind === kind &&
    candidate.recipient === recipient &&
    candidate.network === network &&
    (candidate.mint ?? '') === (mint ?? ''),
  );
  if (exact) return exact;
  if (kind === 'solana-spl' || kind === 'solana-sol') {
    return challenge.paymentMethods.find((candidate) => candidate.kind === kind);
  }
  return challenge.paymentMethods[0];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonObjectValue(value: unknown): JsonObject {
  const record = objectRecord(value);
  if (!record) return {};
  return JSON.parse(JSON.stringify(record)) as JsonObject;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
