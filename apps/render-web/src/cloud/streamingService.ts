import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  Keypair,
  Connection,
  PublicKey,
} from '@solana/web3.js';
import pg from 'pg';
import type { PoolConfig, QueryConfig, QueryResult, QueryResultRow } from 'pg';

import {
  NATIVE_SOL_PSEUDO_MINT,
  STREAMING_VOUCHER_SCHEMA,
  buildApproveDelegateTx,
  buildRevokeDelegateTx,
  formatBaseUnitsToDecimal,
  generateEphemeralKeypair,
  parseTokenAmountToBaseUnits,
  signVoucher,
  validateVoucher,
  type EphemeralKeypair,
  type SessionGrant,
  type StreamingCluster,
  type UnsignedDelegateTx,
  type Voucher,
} from '@solana-agent-wallet-adapter/streaming-sessions';
import type {
  JsonObject as WorkflowJsonObject,
  StreamingVoucherRecord as WorkflowStreamingVoucherRecord,
} from '@solana-agent-wallet-adapter/workflow';

import { solanaRpcUrl } from './connectorFactsReader.js';
import type { PgClient, PgConnection } from './postgresStore.js';
import { postgresSslConfig } from './postgresStore.js';
import type { Clock } from './store.js';

const { Pool } = pg;

const DEFAULT_CLUSTER: StreamingCluster = 'devnet';
const DEFAULT_TOKEN_DECIMALS = 6;
const MAX_RECIPIENT_ALLOWLIST = 64;
const SESSION_LOCK_METADATA_KEY = 'streamingSettlementLock';
const DELEGATE_KEY_METADATA_KEY = 'streamingDelegateKey';
const DELEGATE_PREFUND_LAMPORTS_METADATA_KEY = 'delegatePrefundLamports';
const SIGNER_RUNTIME_METADATA_KEY = 'signerRuntime';
const SERVER_SIGNER_RUNTIME = 'server';
const ANDROID_NATIVE_SIGNER_RUNTIME = 'android-native';
const TEST_RECENT_BLOCKHASH_ENV = 'STREAMING_TEST_RECENT_BLOCKHASH';

// User-funded delegate model: each session pre-funds its ephemeral delegate
// keypair with a small SOL amount so the settlement cron can pay its own
// transaction fees without a shared platform fee-payer wallet.
// 0.005 SOL ≈ ~800 settlement signatures after the rent-exempt minimum.
const DEFAULT_DELEGATE_PREFUND_LAMPORTS = 5_000_000;

function delegatePrefundLamportsFromEnv(): number {
  const raw = process.env.STREAMING_DELEGATE_PREFUND_LAMPORTS;
  if (raw === undefined || raw === '') return DEFAULT_DELEGATE_PREFUND_LAMPORTS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[streaming-session] STREAMING_DELEGATE_PREFUND_LAMPORTS=${raw} is not a non-negative integer; using default ${DEFAULT_DELEGATE_PREFUND_LAMPORTS}.`,
    );
    return DEFAULT_DELEGATE_PREFUND_LAMPORTS;
  }
  return parsed;
}

export interface StoredStreamingSession extends SessionGrant {
  metadata?: Record<string, unknown>;
}

export interface StreamingVoucherRecord extends WorkflowStreamingVoucherRecord {
  voucher: Voucher;
}

export interface CreateStreamingSessionInput {
  walletAddress: string;
  tokenMint: string;
  capAmount: string;
  expiresAt: string;
  recipientAllowlist?: readonly string[];
  cluster?: StreamingCluster;
  tokenDecimals?: number;
  ephemeralSignerPubkey?: string;
  signerRuntime?: StreamingSignerRuntime;
  metadata?: Record<string, unknown>;
}

export type StreamingSignerRuntime = typeof SERVER_SIGNER_RUNTIME | typeof ANDROID_NATIVE_SIGNER_RUNTIME;

export interface CreateStreamingSessionResult {
  session: StoredStreamingSession;
  approveTx: UnsignedDelegateTx;
  ephemeralSignerPubkey: string;
}

export interface AcceptStreamingVoucherResult {
  session: StoredStreamingSession;
  voucher: StreamingVoucherRecord;
  accepted: true;
  remaining: string;
  spentAmount: string;
  voucherHash: string;
}

export interface StreamingVoucherLookupResult {
  session: StoredStreamingSession;
  voucher: StreamingVoucherRecord;
}

export interface SignAndAcceptStreamingVoucherInput {
  walletAddress: string;
  sessionId: string;
  amount: string;
  recipient: string;
  nonce?: string;
  issuedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface StreamingSessionDetail {
  session: StoredStreamingSession;
  vouchers: StreamingVoucherRecord[];
  remaining: string;
  timeToExpirySeconds: number;
}

export interface SettlementCandidate {
  session: StoredStreamingSession;
  unsettledVoucherCount: number;
}

export interface StreamingStore {
  createSession(record: StoredStreamingSession): Promise<StoredStreamingSession>;
  getSession(walletAddress: string, sessionId: string): Promise<StoredStreamingSession | undefined>;
  listSessions(walletAddress: string, status?: StreamingSessionListStatus): Promise<StoredStreamingSession[]>;
  recordGrantSigned(
    walletAddress: string,
    sessionId: string,
    approveTxid: string,
    updatedAt: string,
    status?: StreamingSignedTxCallbackStatus,
    txStatus?: string,
    approvalId?: string,
  ): Promise<StoredStreamingSession | undefined>;
  markRevoked(
    walletAddress: string,
    sessionId: string,
    updatedAt: string,
  ): Promise<StoredStreamingSession | undefined>;
  recordRevokeSigned(
    walletAddress: string,
    sessionId: string,
    revokeTxid: string,
    updatedAt: string,
    status?: StreamingSignedTxCallbackStatus,
    txStatus?: string,
    approvalId?: string,
  ): Promise<StoredStreamingSession | undefined>;
  acceptVoucher(
    walletAddress: string,
    sessionId: string,
    voucher: Voucher,
    nowIso: string,
    voucherId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AcceptStreamingVoucherResult>;
  findVoucherByMppApprovalId(
    walletAddress: string,
    approvalId: string,
  ): Promise<StreamingVoucherLookupResult | undefined>;
  listVouchers(sessionId: string): Promise<StreamingVoucherRecord[]>;
  listSettlementCandidates(
    nowIso: string,
    thresholdBps: number,
    limit: number,
  ): Promise<SettlementCandidate[]>;
  claimSettlementCandidate(
    sessionId: string,
    nowIso: string,
    lockExpiresAtIso: string,
  ): Promise<StoredStreamingSession | undefined>;
  listUnsettledVouchers(sessionId: string): Promise<StreamingVoucherRecord[]>;
  markVouchersSettled(
    sessionId: string,
    voucherHashes: readonly string[],
    txid: string,
    settledAtIso: string,
  ): Promise<StreamingVoucherRecord[]>;
  markSessionSettledIfTerminal(sessionId: string, nowIso: string): Promise<StoredStreamingSession | undefined>;
  /**
   * Phase 5.6 — extend the settlement lock's `expiresAt` to give a slow
   * in-flight settlement more time before another worker can reclaim. Refuses
   * to extend if the lock isn't currently held (i.e. no SESSION_LOCK metadata
   * or it has already expired) so a crashed worker can't "resurrect" a stale
   * lock. Returns the post-update session or undefined if the heartbeat was
   * refused.
   */
  heartbeatSettlementLock(
    sessionId: string,
    nowIso: string,
    lockExpiresAtIso: string,
  ): Promise<StoredStreamingSession | undefined>;
  /**
   * Phase 5.4 — read the most recent settlement attempt persisted by
   * {@link setLastSettlementAttempt}, if any. The settlement service reads
   * this at the start of each settle to reconcile against on-chain state
   * before submitting a fresh tx.
   */
  getLastSettlementAttempt(sessionId: string): Promise<LastSettlementAttempt | undefined>;
  /**
   * Phase 5.4 — record the txid + the voucher hashes the attempt covers
   * + the submission timestamp into session metadata. Pass `null` to clear.
   */
  setLastSettlementAttempt(
    sessionId: string,
    attempt: LastSettlementAttempt | null,
    updatedAtIso: string,
  ): Promise<StoredStreamingSession | undefined>;
}

/**
 * Phase 5.4 settlement-retry safety. Persisted per session in
 * `metadata.lastSettlementAttempt`; cleared after the settle confirms or is
 * declared dead. Used by the cron to avoid double-submitting vouchers when a
 * previous attempt is still pending on-chain.
 */
export interface LastSettlementAttempt {
  txid: string;
  voucherHashes: readonly string[];
  submittedAt: string;
}

export const LAST_SETTLEMENT_ATTEMPT_METADATA_KEY = 'lastSettlementAttempt';

export type StreamingSessionListStatus = SessionGrant['status'] | 'all';
export type StreamingSignedTxCallbackStatus = 'submitted' | 'confirmed';

export interface LatestBlockhashProvider {
  (cluster: StreamingCluster): Promise<string>;
}

export interface StreamingServiceOptions {
  clock?: Clock;
  idFactory?: () => string;
  keypairFactory?: () => EphemeralKeypair;
  latestBlockhash?: LatestBlockhashProvider;
}

export class StreamingServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StreamingServiceError';
  }
}

export class StreamingService {
  private readonly clock: Clock;
  private readonly idFactory: () => string;
  private readonly keypairFactory: () => EphemeralKeypair;
  private readonly latestBlockhash: LatestBlockhashProvider;

  constructor(
    private readonly store: StreamingStore,
    options: StreamingServiceOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.keypairFactory = options.keypairFactory ?? (() => generateEphemeralKeypair());
    this.latestBlockhash = options.latestBlockhash ?? latestBlockhashForCluster;
  }

  async createSession(input: CreateStreamingSessionInput): Promise<CreateStreamingSessionResult> {
    const walletAddress = requirePublicKey(input.walletAddress, 'walletAddress');
    const tokenMint = requirePublicKey(input.tokenMint, 'tokenMint');
    if (tokenMint === NATIVE_SOL_PSEUDO_MINT) {
      throw new StreamingServiceError(
        400,
        'unsupported_native_sol',
        'Native SOL streaming is not supported in v1 — SPL Token delegate authority does not apply to native SOL. Wrap to wSOL (So11111111111111111111111111111111111111112) or pick a regular SPL token like USDC.',
      );
    }
    const cluster = input.cluster ?? defaultStreamingCluster();
    assertStreamingCluster(cluster);
    const tokenDecimals = assertTokenDecimals(input.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS);
    const capAmount = requireAmount(input.capAmount, tokenDecimals, 'capAmount');
    const expiresAt = requireFutureIso(input.expiresAt, this.clock.now(), 'expiresAt');
    const recipientAllowlist = normalizeRecipientAllowlist(input.recipientAllowlist);
    const signerRuntime = normalizeSignerRuntime(input.signerRuntime, input.ephemeralSignerPubkey);
    const keypair = signerRuntime === SERVER_SIGNER_RUNTIME ? this.keypairFactory() : undefined;
    const delegatePubkey = signerRuntime === ANDROID_NATIVE_SIGNER_RUNTIME
      ? requirePublicKey(input.ephemeralSignerPubkey, 'ephemeralSignerPubkey')
      : requirePublicKey(keypair?.publicKey, 'delegatePubkey');
    if (keypair) {
      const delegateSecret = Keypair.fromSecretKey(keypair.secretKey);
      if (delegateSecret.publicKey.toBase58() !== delegatePubkey) {
        throw new StreamingServiceError(500, 'delegate_key_mismatch', 'Generated delegate keypair is internally inconsistent.');
      }
    }

    const now = this.now();
    const id = `stream_${this.idFactory()}`;
    const encryptedDelegateKey = keypair
      ? encryptDelegateKey({
        publicKey: delegatePubkey,
        secretKeyBase64: Buffer.from(keypair.secretKey).toString('base64'),
      })
      : undefined;
    // Only server-runtime delegates (where the cron holds the secret key and
    // signs settlements) need a SOL pre-fund — they're the ones paying their
    // own fees. Android-native sessions are settled on-device and don't need
    // server-side SOL.
    const prefundLamports = signerRuntime === SERVER_SIGNER_RUNTIME
      ? delegatePrefundLamportsFromEnv()
      : 0;
    const session: StoredStreamingSession = {
      sessionId: id,
      walletAddress,
      cluster,
      tokenMint,
      tokenDecimals,
      delegatePubkey,
      ephemeralSignerPubkey: delegatePubkey,
      capAmount,
      spentAmount: '0',
      expiresAt,
      status: 'pending',
      ...(recipientAllowlist.length ? { recipientAllowlist } : {}),
      createdAt: now,
      updatedAt: now,
      metadata: sanitizeSessionMetadata({
        ...(input.metadata ?? {}),
        tokenDecimals,
        [SIGNER_RUNTIME_METADATA_KEY]: signerRuntime,
        ...(encryptedDelegateKey ? { [DELEGATE_KEY_METADATA_KEY]: encryptedDelegateKey } : {}),
        ...(prefundLamports > 0 ? { [DELEGATE_PREFUND_LAMPORTS_METADATA_KEY]: prefundLamports } : {}),
      }),
    };
    const stored = await this.store.createSession(session);
    const approveTx = buildApproveDelegateTx({
      ownerPubkey: walletAddress,
      tokenMint,
      delegatePubkey,
      capAmount,
      tokenDecimals,
      cluster,
      recentBlockhash: await this.latestBlockhash(cluster),
      ...(prefundLamports > 0 ? { delegatePrefundLamports: prefundLamports } : {}),
    });
    return {
      session: publicSession(stored, this.clock.now()),
      approveTx,
      ephemeralSignerPubkey: delegatePubkey,
    };
  }

  async recordGrantSigned(input: {
    walletAddress: string;
    sessionId: string;
    approveTxid: string;
    status?: StreamingSignedTxCallbackStatus;
    txStatus?: string;
    approvalId?: string;
  }): Promise<StoredStreamingSession> {
    const existing = await this.requireSession(input.walletAddress, input.sessionId);
    if (existing.status === 'revoked' || existing.status === 'settled') {
      throw new StreamingServiceError(409, 'session_terminal', 'Session is no longer grantable.');
    }
    if (isExpired(existing, this.clock.now())) {
      throw new StreamingServiceError(409, 'session_expired', 'Session expired before the grant was signed.');
    }
    const updated = await this.store.recordGrantSigned(
      input.walletAddress,
      input.sessionId,
      requireShortString(input.approveTxid, 'approveTxid', 256),
      this.now(),
      normalizeSignedTxCallbackStatus(input.status),
      input.txStatus ? requireShortString(input.txStatus, 'txStatus', 80) : undefined,
      input.approvalId ? requireShortString(input.approvalId, 'approvalId', 160) : undefined,
    );
    if (!updated) throw notFound(input.sessionId);
    return publicSession(updated, this.clock.now());
  }

  async acceptVoucher(input: {
    walletAddress: string;
    sessionId: string;
    voucher: Voucher;
    metadata?: Record<string, unknown>;
  }): Promise<AcceptStreamingVoucherResult> {
    const result = await this.store.acceptVoucher(
      input.walletAddress,
      input.sessionId,
      normalizeVoucher(input.voucher),
      this.now(),
      `voucher_${this.idFactory()}`,
      input.metadata ? sanitizeSessionMetadata(input.metadata) : undefined,
    );
    return {
      ...result,
      session: publicSession(result.session, this.clock.now()),
    };
  }

  async signAndAcceptVoucher(input: SignAndAcceptStreamingVoucherInput): Promise<AcceptStreamingVoucherResult> {
    const session = await this.requireSession(input.walletAddress, input.sessionId);
    if (!sessionHasServerDelegateKey(session)) {
      throw new StreamingServiceError(
        409,
        'native_signer_required',
        'This streaming session is owned by an Android native signer; submit a voucher signed by the device.',
      );
    }
    const tokenDecimals = session.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
    const delegate = decryptSessionDelegateKey(session);
    const issuedAt = input.issuedAt === undefined
      ? this.now()
      : requireIsoTimestamp(input.issuedAt, 'issuedAt');
    const voucher = signVoucher(
      {
        publicKey: delegate.publicKey.toBase58(),
        secretKey: delegate.secretKey,
      },
      {
        sessionId: session.sessionId,
        nonce: input.nonce === undefined
          ? `nonce_${this.idFactory()}`
          : requireShortString(input.nonce, 'nonce', 256),
        amount: requireAmount(input.amount, tokenDecimals, 'amount'),
        recipient: requirePublicKey(input.recipient, 'recipient'),
        issuedAt,
        tokenDecimals,
      },
    );
    return this.acceptVoucher({
      walletAddress: input.walletAddress,
      sessionId: input.sessionId,
      voucher,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  async findVoucherByMppApprovalId(input: {
    walletAddress: string;
    approvalId: string;
  }): Promise<StreamingVoucherLookupResult | undefined> {
    const result = await this.store.findVoucherByMppApprovalId(
      requirePublicKey(input.walletAddress, 'walletAddress'),
      requireShortString(input.approvalId, 'approvalId', 160),
    );
    return result
      ? {
          session: publicSession(result.session, this.clock.now()),
          voucher: result.voucher,
        }
      : undefined;
  }

  async revokeSession(input: {
    walletAddress: string;
    sessionId: string;
  }): Promise<{ session: StoredStreamingSession; revokeTx: UnsignedDelegateTx }> {
    const existing = await this.requireSession(input.walletAddress, input.sessionId);
    if (existing.status === 'settled') {
      throw new StreamingServiceError(409, 'session_settled', 'Session is already settled.');
    }
    const revokeTx = buildRevokeDelegateTx({
      ownerPubkey: existing.walletAddress,
      tokenMint: existing.tokenMint,
      cluster: existing.cluster,
      recentBlockhash: await this.latestBlockhash(existing.cluster),
    });
    return { session: publicSession(existing, this.clock.now()), revokeTx };
  }

  async recordRevokeSigned(input: {
    walletAddress: string;
    sessionId: string;
    revokeTxid: string;
    status?: StreamingSignedTxCallbackStatus;
    txStatus?: string;
    approvalId?: string;
  }): Promise<StoredStreamingSession> {
    await this.requireSession(input.walletAddress, input.sessionId);
    const updated = await this.store.recordRevokeSigned(
      input.walletAddress,
      input.sessionId,
      requireShortString(input.revokeTxid, 'revokeTxid', 256),
      this.now(),
      normalizeSignedTxCallbackStatus(input.status),
      input.txStatus ? requireShortString(input.txStatus, 'txStatus', 80) : undefined,
      input.approvalId ? requireShortString(input.approvalId, 'approvalId', 160) : undefined,
    );
    if (!updated) throw notFound(input.sessionId);
    return publicSession(updated, this.clock.now());
  }

  async listSessions(input: {
    walletAddress: string;
    status?: StreamingSessionListStatus;
  }): Promise<StoredStreamingSession[]> {
    const status = input.status ?? 'active';
    const sessions = await this.store.listSessions(
      input.walletAddress,
      status === 'active' || status === 'expired' ? 'all' : status,
    );
    return sessions
      .map((session) => publicSession(session, this.clock.now()))
      .filter((session) => status === 'all' || session.status === status);
  }

  async getSession(input: {
    walletAddress: string;
    sessionId: string;
  }): Promise<StreamingSessionDetail> {
    const session = await this.requireSession(input.walletAddress, input.sessionId);
    const vouchers = await this.store.listVouchers(session.sessionId);
    const presented = publicSession(session, this.clock.now());
    return {
      session: presented,
      vouchers,
      remaining: remainingFor(presented),
      timeToExpirySeconds: secondsUntil(presented.expiresAt, this.clock.now()),
    };
  }

  private async requireSession(walletAddress: string, sessionId: string): Promise<StoredStreamingSession> {
    const session = await this.store.getSession(walletAddress, sessionId);
    if (!session) throw notFound(sessionId);
    return session;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

export class MemoryStreamingStore implements StreamingStore {
  private readonly sessions = new Map<string, StoredStreamingSession>();
  private readonly vouchers = new Map<string, StreamingVoucherRecord>();

  async createSession(record: StoredStreamingSession): Promise<StoredStreamingSession> {
    this.sessions.set(record.sessionId, clone(record));
    return clone(record);
  }

  async getSession(walletAddress: string, sessionId: string): Promise<StoredStreamingSession | undefined> {
    const record = this.sessions.get(sessionId);
    return record?.walletAddress === walletAddress ? clone(record) : undefined;
  }

  async listSessions(walletAddress: string, status: StreamingSessionListStatus = 'active'): Promise<StoredStreamingSession[]> {
    return [...this.sessions.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .filter((record) => status === 'all' || record.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async recordGrantSigned(
    walletAddress: string,
    sessionId: string,
    approveTxid: string,
    updatedAt: string,
    status: StreamingSignedTxCallbackStatus = 'confirmed',
    txStatus?: string,
    approvalId?: string,
  ): Promise<StoredStreamingSession | undefined> {
    const session = await this.getSession(walletAddress, sessionId);
    if (!session) return undefined;
    const callbackStatus = normalizeSignedTxCallbackStatus(status);
    const updated = {
      ...session,
      approveTxid,
      status: callbackStatus === 'confirmed' && session.status === 'pending' ? 'active' : session.status,
      updatedAt,
      metadata: mergeSignedTxMetadata(session, 'grantTx', approveTxid, callbackStatus, txStatus, approvalId, updatedAt),
    } satisfies StoredStreamingSession;
    this.sessions.set(sessionId, clone(updated));
    return clone(updated);
  }

  async markRevoked(
    walletAddress: string,
    sessionId: string,
    updatedAt: string,
  ): Promise<StoredStreamingSession | undefined> {
    const session = await this.getSession(walletAddress, sessionId);
    if (!session) return undefined;
    const updated = {
      ...session,
      status: 'revoked',
      updatedAt,
    } satisfies StoredStreamingSession;
    this.sessions.set(sessionId, clone(updated));
    return clone(updated);
  }

  async recordRevokeSigned(
    walletAddress: string,
    sessionId: string,
    revokeTxid: string,
    updatedAt: string,
    status: StreamingSignedTxCallbackStatus = 'confirmed',
    txStatus?: string,
    approvalId?: string,
  ): Promise<StoredStreamingSession | undefined> {
    const session = await this.getSession(walletAddress, sessionId);
    if (!session) return undefined;
    const callbackStatus = normalizeSignedTxCallbackStatus(status);
    const updated = {
      ...session,
      status: callbackStatus === 'confirmed' ? 'revoked' : session.status,
      revokeTxid,
      updatedAt,
      metadata: mergeSignedTxMetadata(session, 'revokeTx', revokeTxid, callbackStatus, txStatus, approvalId, updatedAt),
    } satisfies StoredStreamingSession;
    this.sessions.set(sessionId, clone(updated));
    return clone(updated);
  }

  async acceptVoucher(
    walletAddress: string,
    sessionId: string,
    voucher: Voucher,
    nowIso: string,
    voucherId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AcceptStreamingVoucherResult> {
    const session = await this.getSession(walletAddress, sessionId);
    if (!session) throw notFound(sessionId);
    const mppApprovalId = mppApprovalIdFromVoucherMetadata(metadata);
    if (mppApprovalId) {
      for (const existing of this.vouchers.values()) {
        if (mppApprovalIdFromVoucherMetadata(existing.metadata) !== mppApprovalId) continue;
        const existingSession = this.sessions.get(existing.sessionId);
        if (existingSession?.walletAddress === walletAddress) {
          throw new StreamingServiceError(409, 'mpp_session_payment_exists', 'MPP approval already has a streaming-session voucher.');
        }
      }
    }
    const usedNonces = new Set(
      [...this.vouchers.values()]
        .filter((record) => record.sessionId === sessionId)
        .map((record) => record.nonce),
    );
    const validation = validateVoucher({
      grant: session,
      voucher,
      usedNonces,
      now: nowIso,
    });
    const decimals = session.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
    const spentAmount = formatBaseUnitsToDecimal(validation.spentBaseUnits + validation.amountBaseUnits, decimals);
    const updated = {
      ...session,
      spentAmount,
      updatedAt: nowIso,
    } satisfies StoredStreamingSession;
    const record = voucherRecordFromVoucher(voucherId, voucher, validation.voucherHash, nowIso, metadata);
    this.sessions.set(sessionId, clone(updated));
    this.vouchers.set(record.id, clone(record));
    return {
      session: clone(updated),
      voucher: clone(record),
      accepted: true,
      remaining: validation.remainingAmount,
      spentAmount,
      voucherHash: validation.voucherHash,
    };
  }

  async findVoucherByMppApprovalId(
    walletAddress: string,
    approvalId: string,
  ): Promise<StreamingVoucherLookupResult | undefined> {
    for (const voucher of this.vouchers.values()) {
      if (mppApprovalIdFromVoucherMetadata(voucher.metadata) !== approvalId) continue;
      const session = this.sessions.get(voucher.sessionId);
      if (!session || session.walletAddress !== walletAddress) continue;
      return { session: clone(session), voucher: clone(voucher) };
    }
    return undefined;
  }

  async listVouchers(sessionId: string): Promise<StreamingVoucherRecord[]> {
    return [...this.vouchers.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async listSettlementCandidates(
    nowIso: string,
    thresholdBps: number,
    limit: number,
  ): Promise<SettlementCandidate[]> {
    const now = new Date(nowIso);
    const candidates: SettlementCandidate[] = [];
    for (const session of this.sessions.values()) {
      if (session.status === 'pending' || session.status === 'settled') continue;
      if (!sessionHasServerDelegateKey(session)) continue;
      if (settlementLockActive(session, now)) continue;
      const unsettled = [...this.vouchers.values()].filter((v) => v.sessionId === session.sessionId && !v.settledAt);
      if (unsettled.length === 0 && sessionDelegatePrefundLamports(session) <= 0) continue;
      if (!sessionSettlementEligible(session, now, thresholdBps)) continue;
      candidates.push({ session: clone(session), unsettledVoucherCount: unsettled.length });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }

  async claimSettlementCandidate(
    sessionId: string,
    nowIso: string,
    lockExpiresAtIso: string,
  ): Promise<StoredStreamingSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session || settlementLockActive(session, new Date(nowIso))) return undefined;
    const updated = {
      ...session,
      updatedAt: nowIso,
      metadata: {
        ...(session.metadata ?? {}),
        [SESSION_LOCK_METADATA_KEY]: { lockedAt: nowIso, expiresAt: lockExpiresAtIso },
      },
    };
    this.sessions.set(sessionId, clone(updated));
    return clone(updated);
  }

  async listUnsettledVouchers(sessionId: string): Promise<StreamingVoucherRecord[]> {
    return [...this.vouchers.values()]
      .filter((record) => record.sessionId === sessionId && !record.settledAt)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async markVouchersSettled(
    sessionId: string,
    voucherHashes: readonly string[],
    txid: string,
    settledAtIso: string,
  ): Promise<StreamingVoucherRecord[]> {
    const wanted = new Set(voucherHashes);
    const updated: StreamingVoucherRecord[] = [];
    for (const [id, record] of this.vouchers.entries()) {
      if (record.sessionId !== sessionId || !wanted.has(record.voucherHash) || record.settledAt) continue;
      const settled = { ...record, settledAt: settledAtIso, settlementTxid: txid };
      this.vouchers.set(id, clone(settled));
      updated.push(clone(settled));
    }
    return updated;
  }

  async markSessionSettledIfTerminal(sessionId: string, nowIso: string): Promise<StoredStreamingSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const hasUnsettled = [...this.vouchers.values()].some((record) => record.sessionId === sessionId && !record.settledAt);
    if (hasUnsettled || !isTerminalForSettlement(session, new Date(nowIso))) return clone(session);
    const updated = {
      ...session,
      status: 'settled',
      updatedAt: nowIso,
    } satisfies StoredStreamingSession;
    this.sessions.set(sessionId, clone(updated));
    return clone(updated);
  }

  async heartbeatSettlementLock(
    sessionId: string,
    nowIso: string,
    lockExpiresAtIso: string,
  ): Promise<StoredStreamingSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const lock = session.metadata?.[SESSION_LOCK_METADATA_KEY] as { lockedAt?: string; expiresAt?: string } | undefined;
    if (!lock?.expiresAt) return undefined;
    if (new Date(lock.expiresAt).getTime() <= new Date(nowIso).getTime()) return undefined;
    const updated = {
      ...session,
      updatedAt: nowIso,
      metadata: {
        ...(session.metadata ?? {}),
        [SESSION_LOCK_METADATA_KEY]: { ...lock, expiresAt: lockExpiresAtIso },
      },
    };
    this.sessions.set(sessionId, clone(updated));
    return clone(updated);
  }

  async getLastSettlementAttempt(sessionId: string): Promise<LastSettlementAttempt | undefined> {
    const session = this.sessions.get(sessionId);
    const value = session?.metadata?.[LAST_SETTLEMENT_ATTEMPT_METADATA_KEY];
    return isLastSettlementAttempt(value) ? clone(value) : undefined;
  }

  async setLastSettlementAttempt(
    sessionId: string,
    attempt: LastSettlementAttempt | null,
    updatedAtIso: string,
  ): Promise<StoredStreamingSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const metadata = { ...(session.metadata ?? {}) };
    if (attempt) {
      metadata[LAST_SETTLEMENT_ATTEMPT_METADATA_KEY] = clone(attempt);
    } else {
      delete metadata[LAST_SETTLEMENT_ATTEMPT_METADATA_KEY];
    }
    const updated = { ...session, updatedAt: updatedAtIso, metadata };
    this.sessions.set(sessionId, clone(updated));
    return clone(updated);
  }
}

function isLastSettlementAttempt(value: unknown): value is LastSettlementAttempt {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.txid === 'string'
    && typeof record.submittedAt === 'string'
    && Array.isArray(record.voucherHashes)
    && (record.voucherHashes as unknown[]).every((entry) => typeof entry === 'string')
  );
}

export class PostgresStreamingStore implements StreamingStore {
  private readonly client: PgClient;
  private readonly ownsClient: boolean;

  constructor(options: { client?: PgClient; connectionString?: string } = {}) {
    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
      return;
    }
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for PostgresStreamingStore.');
    }
    this.client = new Pool({
      connectionString,
      max: envInteger('DATABASE_POOL_SIZE', 5),
      ...postgresSslConfig(connectionString),
    } satisfies PoolConfig);
    this.ownsClient = true;
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client.end) await this.client.end();
  }

  async createSession(record: StoredStreamingSession): Promise<StoredStreamingSession> {
    await this.ensureUser(record.walletAddress, record.createdAt);
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.session.insert',
      text: `
        INSERT INTO streaming_sessions (
          id, wallet_address, cluster, token_mint, delegate_pubkey, ephemeral_signer_pubkey,
          cap_amount, spent_amount, expires_at, status, recipient_allowlist, approve_txid,
          revoke_txid, created_at, updated_at, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16::jsonb
        )
        RETURNING *
      `,
      values: [
        record.sessionId,
        record.walletAddress,
        record.cluster,
        record.tokenMint,
        record.delegatePubkey,
        record.ephemeralSignerPubkey,
        record.capAmount,
        record.spentAmount,
        record.expiresAt,
        record.status,
        record.recipientAllowlist ? jsonParam(record.recipientAllowlist) : null,
        record.approveTxid ?? null,
        record.revokeTxid ?? null,
        record.createdAt,
        record.updatedAt,
        record.metadata ? jsonParam(record.metadata) : null,
      ],
    });
    return sessionFromRow(result.rows[0]);
  }

  async getSession(walletAddress: string, sessionId: string): Promise<StoredStreamingSession | undefined> {
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.session.getForWallet',
      text: 'SELECT * FROM streaming_sessions WHERE id = $1 AND wallet_address = $2',
      values: [sessionId, walletAddress],
    });
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async listSessions(walletAddress: string, status: StreamingSessionListStatus = 'active'): Promise<StoredStreamingSession[]> {
    const result = await this.query<StreamingSessionRow>({
      name: status === 'all' ? 'streaming.session.listAll' : 'streaming.session.listByStatus',
      text: status === 'all'
        ? 'SELECT * FROM streaming_sessions WHERE wallet_address = $1 ORDER BY created_at DESC'
        : 'SELECT * FROM streaming_sessions WHERE wallet_address = $1 AND status = $2 ORDER BY created_at DESC',
      values: status === 'all' ? [walletAddress] : [walletAddress, status],
    });
    return result.rows.map(sessionFromRow);
  }

  async recordGrantSigned(
    walletAddress: string,
    sessionId: string,
    approveTxid: string,
    updatedAt: string,
    status: StreamingSignedTxCallbackStatus = 'confirmed',
    txStatus?: string,
    approvalId?: string,
  ): Promise<StoredStreamingSession | undefined> {
    const callbackStatus = normalizeSignedTxCallbackStatus(status);
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.session.recordGrantSigned.v2',
      text: `
        UPDATE streaming_sessions
        SET approve_txid = $3,
            status = CASE WHEN $6 = 'confirmed' AND status = 'pending' THEN 'active' ELSE status END,
            updated_at = $4,
            metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
        WHERE id = $1 AND wallet_address = $2
        RETURNING *
      `,
      values: [
        sessionId,
        walletAddress,
        approveTxid,
        updatedAt,
        jsonParam(signedTxMetadataPatch('grantTx', approveTxid, callbackStatus, txStatus, approvalId, updatedAt)),
        callbackStatus,
      ],
    });
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async markRevoked(
    walletAddress: string,
    sessionId: string,
    updatedAt: string,
  ): Promise<StoredStreamingSession | undefined> {
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.session.markRevoked',
      text: `
        UPDATE streaming_sessions
        SET status = 'revoked', updated_at = $3
        WHERE id = $1 AND wallet_address = $2
        RETURNING *
      `,
      values: [sessionId, walletAddress, updatedAt],
    });
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async recordRevokeSigned(
    walletAddress: string,
    sessionId: string,
    revokeTxid: string,
    updatedAt: string,
    status: StreamingSignedTxCallbackStatus = 'confirmed',
    txStatus?: string,
    approvalId?: string,
  ): Promise<StoredStreamingSession | undefined> {
    const callbackStatus = normalizeSignedTxCallbackStatus(status);
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.session.recordRevokeSigned.v2',
      text: `
        UPDATE streaming_sessions
        SET revoke_txid = $3,
            status = CASE WHEN $6 = 'confirmed' THEN 'revoked' ELSE status END,
            updated_at = $4,
            metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
        WHERE id = $1 AND wallet_address = $2
        RETURNING *
      `,
      values: [
        sessionId,
        walletAddress,
        revokeTxid,
        updatedAt,
        jsonParam(signedTxMetadataPatch('revokeTx', revokeTxid, callbackStatus, txStatus, approvalId, updatedAt)),
        callbackStatus,
      ],
    });
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async acceptVoucher(
    walletAddress: string,
    sessionId: string,
    voucher: Voucher,
    nowIso: string,
    voucherId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AcceptStreamingVoucherResult> {
    const client = await this.checkoutClient();
    await client.query({ text: 'BEGIN' });
    try {
      const sessionResult = await client.query<StreamingSessionRow>({
        name: 'streaming.session.lockForVoucher',
        text: 'SELECT * FROM streaming_sessions WHERE id = $1 AND wallet_address = $2 FOR UPDATE',
        values: [sessionId, walletAddress],
      });
      const sessionRow = sessionResult.rows[0];
      if (!sessionRow) throw notFound(sessionId);
      const session = sessionFromRow(sessionRow);
      const nonceResult = await client.query<{ nonce: string }>({
        name: 'streaming.voucher.usedNonce',
        text: 'SELECT nonce FROM streaming_vouchers WHERE session_id = $1 AND nonce = $2 LIMIT 1',
        values: [sessionId, voucher.nonce],
      });
      const validation = validateVoucher({
        grant: session,
        voucher,
        usedNonces: new Set(nonceResult.rows.map((row) => row.nonce)),
        now: nowIso,
      });
      const decimals = session.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
      const spentAmount = formatBaseUnitsToDecimal(validation.spentBaseUnits + validation.amountBaseUnits, decimals);
      const voucherRecord = voucherRecordFromVoucher(voucherId, voucher, validation.voucherHash, nowIso, metadata);
      await client.query({
        name: 'streaming.voucher.insert',
        text: `
          INSERT INTO streaming_vouchers (
            id, session_id, nonce, amount, recipient, voucher_hash, signature, issued_at, created_at,
            settled_at, settlement_txid, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10::jsonb)
        `,
        values: [
          voucherRecord.id,
          voucherRecord.sessionId,
          voucherRecord.nonce,
          voucherRecord.amount,
          voucherRecord.recipient,
          voucherRecord.voucherHash,
          voucherRecord.signature,
          voucherRecord.issuedAt,
          voucherRecord.createdAt,
          jsonParam(voucherRecord.metadata ?? {}),
        ],
      });
      const updatedResult = await client.query<StreamingSessionRow>({
        name: 'streaming.session.updateSpent',
        text: `
          UPDATE streaming_sessions
          SET spent_amount = $3, updated_at = $4
          WHERE id = $1 AND wallet_address = $2
          RETURNING *
        `,
        values: [sessionId, walletAddress, spentAmount, nowIso],
      });
      await client.query({ text: 'COMMIT' });
      return {
        session: sessionFromRow(updatedResult.rows[0]),
        voucher: voucherRecord,
        accepted: true,
        remaining: validation.remainingAmount,
        spentAmount,
        voucherHash: validation.voucherHash,
      };
    } catch (err) {
      await client.query({ text: 'ROLLBACK' });
      if (isPgUniqueViolation(err, 'streaming_vouchers_session_nonce_uidx')) {
        throw new StreamingServiceError(409, 'voucher_replay', 'Voucher nonce has already been used.');
      }
      if (isPgUniqueViolation(err, 'streaming_vouchers_mpp_approval_uidx')) {
        throw new StreamingServiceError(409, 'mpp_session_payment_exists', 'MPP approval already has a streaming-session voucher.');
      }
      throw err;
    } finally {
      client.release?.();
    }
  }

  async findVoucherByMppApprovalId(
    walletAddress: string,
    approvalId: string,
  ): Promise<StreamingVoucherLookupResult | undefined> {
    const result = await this.query<StreamingVoucherRow>({
      name: 'streaming.voucher.findByMppApprovalId',
      text: `
        SELECT v.*
        FROM streaming_vouchers v
        JOIN streaming_sessions s ON s.id = v.session_id
        WHERE s.wallet_address = $1
          AND v.metadata #>> '{mppSessionPayment,approvalId}' = $2
        ORDER BY v.created_at ASC, v.id ASC
        LIMIT 1
      `,
      values: [walletAddress, approvalId],
    });
    const row = result.rows[0];
    if (!row) return undefined;
    const session = await this.getSession(walletAddress, row.session_id);
    return session ? { session, voucher: voucherFromRow(row) } : undefined;
  }

  async listVouchers(sessionId: string): Promise<StreamingVoucherRecord[]> {
    const result = await this.query<StreamingVoucherRow>({
      name: 'streaming.voucher.listBySession',
      text: 'SELECT * FROM streaming_vouchers WHERE session_id = $1 ORDER BY created_at ASC, id ASC',
      values: [sessionId],
    });
    return result.rows.map(voucherFromRow);
  }

  async listSettlementCandidates(
    nowIso: string,
    thresholdBps: number,
    limit: number,
  ): Promise<SettlementCandidate[]> {
    const threshold = thresholdBps / 10_000;
    const result = await this.query<StreamingCandidateRow>({
      name: 'streaming.settlement.candidates',
      text: `
        SELECT s.*, COUNT(v.id)::int AS unsettled_voucher_count
        FROM streaming_sessions s
        LEFT JOIN streaming_vouchers v ON v.session_id = s.id AND v.settled_at IS NULL
        WHERE s.status <> 'pending'
          AND s.status <> 'settled'
          AND COALESCE(s.metadata->>'${SIGNER_RUNTIME_METADATA_KEY}', '${SERVER_SIGNER_RUNTIME}') = '${SERVER_SIGNER_RUNTIME}'
          AND (
            v.id IS NOT NULL
            OR COALESCE((s.metadata->>'${DELEGATE_PREFUND_LAMPORTS_METADATA_KEY}')::numeric, 0) > 0
          )
          AND (
            s.expires_at <= $1
            OR s.status = 'revoked'
            OR s.spent_amount::numeric >= (s.cap_amount::numeric * $2::numeric)
          )
          AND COALESCE((s.metadata->'${SESSION_LOCK_METADATA_KEY}'->>'expiresAt')::timestamptz, 'epoch'::timestamptz) <= $1
        GROUP BY s.id
        ORDER BY s.expires_at ASC, s.created_at ASC
        LIMIT $3
      `,
      values: [nowIso, String(threshold), limit],
    });
    return result.rows.map((row) => ({
      session: sessionFromRow(row),
      unsettledVoucherCount: Number(row.unsettled_voucher_count) || 0,
    }));
  }

  async claimSettlementCandidate(
    sessionId: string,
    nowIso: string,
    lockExpiresAtIso: string,
  ): Promise<StoredStreamingSession | undefined> {
    const lock = { lockedAt: nowIso, expiresAt: lockExpiresAtIso };
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.settlement.claim',
      text: `
        UPDATE streaming_sessions
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${SESSION_LOCK_METADATA_KEY}}', $3::jsonb, true),
            updated_at = $2
        WHERE id = $1
          AND COALESCE((metadata->'${SESSION_LOCK_METADATA_KEY}'->>'expiresAt')::timestamptz, 'epoch'::timestamptz) <= $2
        RETURNING *
      `,
      values: [sessionId, nowIso, jsonParam(lock)],
    });
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async listUnsettledVouchers(sessionId: string): Promise<StreamingVoucherRecord[]> {
    const result = await this.query<StreamingVoucherRow>({
      name: 'streaming.voucher.listUnsettled',
      text: `
        SELECT * FROM streaming_vouchers
        WHERE session_id = $1 AND settled_at IS NULL
        ORDER BY created_at ASC, id ASC
      `,
      values: [sessionId],
    });
    return result.rows.map(voucherFromRow);
  }

  async markVouchersSettled(
    sessionId: string,
    voucherHashes: readonly string[],
    txid: string,
    settledAtIso: string,
  ): Promise<StreamingVoucherRecord[]> {
    if (voucherHashes.length === 0) return [];
    const result = await this.query<StreamingVoucherRow>({
      name: 'streaming.voucher.markSettled',
      text: `
        UPDATE streaming_vouchers
        SET settled_at = $3, settlement_txid = $4
        WHERE session_id = $1
          AND voucher_hash = ANY($2::text[])
          AND settled_at IS NULL
        RETURNING *
      `,
      values: [sessionId, voucherHashes, settledAtIso, txid],
    });
    return result.rows.map(voucherFromRow);
  }

  async markSessionSettledIfTerminal(sessionId: string, nowIso: string): Promise<StoredStreamingSession | undefined> {
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.session.markSettledIfTerminal',
      text: `
        UPDATE streaming_sessions
        SET status = 'settled', updated_at = $2
        WHERE id = $1
          AND NOT EXISTS (
            SELECT 1 FROM streaming_vouchers v
            WHERE v.session_id = streaming_sessions.id AND v.settled_at IS NULL
          )
          AND (
            expires_at <= $2
            OR status IN ('revoked', 'expired')
            OR spent_amount::numeric >= cap_amount::numeric
          )
        RETURNING *
      `,
      values: [sessionId, nowIso],
    });
    if (result.rows[0]) return sessionFromRow(result.rows[0]);
    const existing = await this.query<StreamingSessionRow>({
      name: 'streaming.session.getAny',
      text: 'SELECT * FROM streaming_sessions WHERE id = $1',
      values: [sessionId],
    });
    return existing.rows[0] ? sessionFromRow(existing.rows[0]) : undefined;
  }

  async heartbeatSettlementLock(
    sessionId: string,
    nowIso: string,
    lockExpiresAtIso: string,
  ): Promise<StoredStreamingSession | undefined> {
    // Phase 5.6 — extend the in-flight lock's expiresAt. The conditional WHERE
    // refuses to extend if the lock isn't currently held, so a crashed worker
    // can't write over a fresh lock another worker just acquired.
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.settlement.heartbeat',
      text: `
        UPDATE streaming_sessions
        SET metadata = jsonb_set(metadata, '{${SESSION_LOCK_METADATA_KEY},expiresAt}', $3::jsonb, true),
            updated_at = $2
        WHERE id = $1
          AND metadata ? '${SESSION_LOCK_METADATA_KEY}'
          AND COALESCE((metadata->'${SESSION_LOCK_METADATA_KEY}'->>'expiresAt')::timestamptz, 'epoch'::timestamptz) > $2
        RETURNING *
      `,
      values: [sessionId, nowIso, jsonParam(lockExpiresAtIso)],
    });
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async getLastSettlementAttempt(sessionId: string): Promise<LastSettlementAttempt | undefined> {
    const result = await this.query<StreamingSessionRow>({
      name: 'streaming.settlement.getLastAttempt',
      text: 'SELECT metadata FROM streaming_sessions WHERE id = $1',
      values: [sessionId],
    });
    const metadata = result.rows[0]?.metadata as Record<string, unknown> | null | undefined;
    const value = metadata?.[LAST_SETTLEMENT_ATTEMPT_METADATA_KEY];
    return isLastSettlementAttempt(value) ? value : undefined;
  }

  async setLastSettlementAttempt(
    sessionId: string,
    attempt: LastSettlementAttempt | null,
    updatedAtIso: string,
  ): Promise<StoredStreamingSession | undefined> {
    const result = attempt === null
      ? await this.query<StreamingSessionRow>({
          name: 'streaming.settlement.clearLastAttempt',
          text: `
            UPDATE streaming_sessions
            SET metadata = COALESCE(metadata, '{}'::jsonb) - '${LAST_SETTLEMENT_ATTEMPT_METADATA_KEY}',
                updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          values: [sessionId, updatedAtIso],
        })
      : await this.query<StreamingSessionRow>({
          name: 'streaming.settlement.setLastAttempt',
          text: `
            UPDATE streaming_sessions
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${LAST_SETTLEMENT_ATTEMPT_METADATA_KEY}}', $3::jsonb, true),
                updated_at = $2
            WHERE id = $1
            RETURNING *
          `,
          values: [sessionId, updatedAtIso, jsonParam(attempt)],
        });
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  private async ensureUser(walletAddress: string, createdAt: string): Promise<void> {
    await this.query({
      name: 'streaming.user.upsert',
      text: `
        INSERT INTO users (wallet_address, created_at, updated_at, last_seen_at)
        VALUES ($1, $2, $2, $2)
        ON CONFLICT (wallet_address) DO UPDATE SET
          updated_at = EXCLUDED.updated_at,
          last_seen_at = COALESCE(users.last_seen_at, EXCLUDED.last_seen_at)
      `,
      values: [walletAddress, createdAt],
    });
  }

  private query<R extends QueryResultRow = QueryResultRow>(query: QueryConfig): Promise<QueryResult<R>> {
    return this.client.query<R>(query);
  }

  private async checkoutClient(): Promise<PgClient> {
    const connect = (this.client as PgClient & { connect?: () => Promise<PgConnection> }).connect;
    if (connect) return connect.call(this.client);
    return this.client;
  }
}

const streamingStores = new WeakMap<object, StreamingStore>();
let defaultStreamingStore: StreamingStore | undefined;

export function streamingStoreFor(backingStore?: unknown): StreamingStore {
  if (isStreamingStore(backingStore)) return backingStore;
  if (backingStore && typeof backingStore === 'object') {
    const cached = streamingStores.get(backingStore);
    if (cached) return cached;
    const pgClient = pgClientFromStore(backingStore);
    const store = pgClient
      ? new PostgresStreamingStore({ client: pgClient })
      : shouldUseStandalonePostgres()
        ? new PostgresStreamingStore()
        : new MemoryStreamingStore();
    streamingStores.set(backingStore, store);
    return store;
  }
  if (!defaultStreamingStore) {
    defaultStreamingStore = shouldUseStandalonePostgres()
      ? new PostgresStreamingStore()
      : new MemoryStreamingStore();
  }
  return defaultStreamingStore;
}

export function publicSession(session: StoredStreamingSession, now: Date): StoredStreamingSession {
  const {
    [DELEGATE_KEY_METADATA_KEY]: _delegateKey,
    [SESSION_LOCK_METADATA_KEY]: _lock,
    [LAST_SETTLEMENT_ATTEMPT_METADATA_KEY]: _lastAttempt,
    ...metadata
  } = session.metadata ?? {};
  const safeMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;
  return {
    ...session,
    status: isExpired(session, now) && (session.status === 'active' || session.status === 'pending')
      ? 'expired'
      : session.status,
    ...(safeMetadata ? { metadata: safeMetadata } : { metadata: undefined }),
  };
}

export function decryptSessionDelegateKey(session: StoredStreamingSession): Keypair {
  if (!sessionHasServerDelegateKey(session)) {
    throw new StreamingServiceError(
      409,
      'native_signer_required',
      'Session delegate key is held by the Android native signer.',
    );
  }
  const encrypted = session.metadata?.[DELEGATE_KEY_METADATA_KEY];
  if (!encrypted || typeof encrypted !== 'object' || Array.isArray(encrypted)) {
    throw new StreamingServiceError(409, 'delegate_key_missing', 'Session is missing encrypted delegate key material.');
  }
  const decrypted = decryptDelegateKey(encrypted as EncryptedDelegateKey);
  if (decrypted.publicKey !== session.delegatePubkey) {
    throw new StreamingServiceError(409, 'delegate_key_mismatch', 'Encrypted delegate key does not match session delegate pubkey.');
  }
  return Keypair.fromSecretKey(Buffer.from(decrypted.secretKeyBase64, 'base64'));
}

export function signerRuntimeFor(session: StoredStreamingSession): StreamingSignerRuntime {
  const value = session.metadata?.[SIGNER_RUNTIME_METADATA_KEY];
  return value === ANDROID_NATIVE_SIGNER_RUNTIME ? ANDROID_NATIVE_SIGNER_RUNTIME : SERVER_SIGNER_RUNTIME;
}

export function sessionHasServerDelegateKey(session: StoredStreamingSession): boolean {
  return signerRuntimeFor(session) === SERVER_SIGNER_RUNTIME;
}

export function sessionDelegatePrefundLamports(session: StoredStreamingSession): number {
  const raw = session.metadata?.[DELEGATE_PREFUND_LAMPORTS_METADATA_KEY];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) return 0;
  return raw;
}

export function normalizeVoucher(input: unknown): Voucher {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new StreamingServiceError(400, 'invalid_voucher', 'voucher must be an object.');
  }
  const record = input as Record<string, unknown>;
  const schema = record.schema === undefined ? STREAMING_VOUCHER_SCHEMA : requireString(record.schema, 'voucher.schema');
  if (schema !== STREAMING_VOUCHER_SCHEMA) {
    throw new StreamingServiceError(400, 'invalid_schema', `voucher.schema must be ${STREAMING_VOUCHER_SCHEMA}.`);
  }
  return {
    schema: STREAMING_VOUCHER_SCHEMA,
    sessionId: requireString(record.sessionId, 'voucher.sessionId'),
    nonce: requireString(record.nonce, 'voucher.nonce'),
    amount: requireString(record.amount, 'voucher.amount'),
    recipient: requireString(record.recipient, 'voucher.recipient'),
    issuedAt: requireString(record.issuedAt, 'voucher.issuedAt'),
    signature: requireString(record.signature, 'voucher.signature'),
  };
}

export function remainingFor(session: SessionGrant): string {
  const decimals = session.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const cap = parseTokenAmountToBaseUnits(session.capAmount, decimals, { field: 'capAmount' });
  const spent = parseTokenAmountToBaseUnits(session.spentAmount, decimals, {
    allowZero: true,
    field: 'spentAmount',
  });
  return formatBaseUnitsToDecimal(cap > spent ? cap - spent : 0n, decimals);
}

function latestBlockhashForCluster(cluster: StreamingCluster): Promise<string> {
  const testBlockhash = process.env[TEST_RECENT_BLOCKHASH_ENV]?.trim();
  if (testBlockhash) return Promise.resolve(testBlockhash);
  return new Connection(solanaRpcUrl(cluster), 'confirmed')
    .getLatestBlockhash('confirmed')
    .then((result) => result.blockhash);
}

function defaultStreamingCluster(): StreamingCluster {
  const raw = process.env.STREAMING_DEFAULT_CLUSTER?.trim();
  if (raw) {
    assertStreamingCluster(raw);
    return raw;
  }
  return DEFAULT_CLUSTER;
}

function assertStreamingCluster(value: unknown): asserts value is StreamingCluster {
  if (value !== 'mainnet-beta' && value !== 'testnet' && value !== 'devnet' && value !== 'localnet') {
    throw new StreamingServiceError(400, 'invalid_cluster', 'cluster must be mainnet-beta, testnet, devnet, or localnet.');
  }
}

function normalizeSignerRuntime(value: unknown, ephemeralSignerPubkey: unknown): StreamingSignerRuntime {
  if (value === undefined || value === null || value === '') {
    return ephemeralSignerPubkey === undefined || ephemeralSignerPubkey === null || ephemeralSignerPubkey === ''
      ? SERVER_SIGNER_RUNTIME
      : ANDROID_NATIVE_SIGNER_RUNTIME;
  }
  if (value === SERVER_SIGNER_RUNTIME || value === ANDROID_NATIVE_SIGNER_RUNTIME) return value;
  throw new StreamingServiceError(400, 'invalid_signer_runtime', 'signerRuntime must be server or android-native.');
}

function requirePublicKey(value: unknown, field: string): string {
  const text = requireString(value, field).trim();
  try {
    return new PublicKey(text).toBase58();
  } catch (err) {
    throw new StreamingServiceError(400, 'invalid_public_key', `${field} must be a valid Solana public key.`);
  }
}

function requireAmount(value: unknown, decimals: number, field: string): string {
  const text = requireString(value, field).trim();
  parseTokenAmountToBaseUnits(text, decimals, { field });
  return text;
}

function requireFutureIso(value: unknown, now: Date, field: string): string {
  const text = requireString(value, field).trim();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new StreamingServiceError(400, 'invalid_timestamp', `${field} must be an ISO-8601 timestamp.`);
  }
  if (date.getTime() <= now.getTime()) {
    throw new StreamingServiceError(400, 'expires_at_past', `${field} must be in the future.`);
  }
  return date.toISOString();
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const text = requireString(value, field).trim();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new StreamingServiceError(400, 'invalid_timestamp', `${field} must be an ISO-8601 timestamp.`);
  }
  return date.toISOString();
}

function requireShortString(value: unknown, field: string, max: number): string {
  const text = requireString(value, field).trim();
  if (text.length > max) {
    throw new StreamingServiceError(400, 'field_too_long', `${field} must be at most ${max} characters.`);
  }
  return text;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StreamingServiceError(400, 'missing_field', `${field} is required.`);
  }
  return value;
}

function assertTokenDecimals(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new StreamingServiceError(400, 'invalid_token_decimals', 'tokenDecimals must be an integer between 0 and 255.');
  }
  return value;
}

function normalizeRecipientAllowlist(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new StreamingServiceError(400, 'invalid_allowlist', 'recipientAllowlist must be an array.');
  }
  if (value.length > MAX_RECIPIENT_ALLOWLIST) {
    throw new StreamingServiceError(400, 'allowlist_too_large', `recipientAllowlist must contain at most ${MAX_RECIPIENT_ALLOWLIST} recipients.`);
  }
  const normalized = value.map((entry, index) => requirePublicKey(entry, `recipientAllowlist[${index}]`));
  return [...new Set(normalized)];
}

function sanitizeSessionMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeSignedTxCallbackStatus(
  status: StreamingSignedTxCallbackStatus | undefined,
): StreamingSignedTxCallbackStatus {
  return status === 'submitted' ? 'submitted' : 'confirmed';
}

function signedTxMetadataPatch(
  key: 'grantTx' | 'revokeTx',
  txid: string,
  status: StreamingSignedTxCallbackStatus,
  txStatus: string | undefined,
  approvalId: string | undefined,
  updatedAt: string,
): Record<string, unknown> {
  return {
    [key]: sanitizeSessionMetadata({
      txid,
      status,
      txStatus: txStatus || (status === 'confirmed' ? 'confirmed' : 'pending'),
      updatedAt,
      ...(approvalId ? { approvalId } : {}),
    }),
  };
}

function mergeSignedTxMetadata(
  session: StoredStreamingSession,
  key: 'grantTx' | 'revokeTx',
  txid: string,
  status: StreamingSignedTxCallbackStatus,
  txStatus: string | undefined,
  approvalId: string | undefined,
  updatedAt: string,
): Record<string, unknown> {
  return sanitizeSessionMetadata({
    ...(session.metadata ?? {}),
    ...signedTxMetadataPatch(key, txid, status, txStatus, approvalId, updatedAt),
  });
}

function mppApprovalIdFromVoucherMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const link = metadata?.mppSessionPayment;
  if (!link || typeof link !== 'object' || Array.isArray(link)) return undefined;
  const approvalId = (link as Record<string, unknown>).approvalId;
  return typeof approvalId === 'string' && approvalId.trim() ? approvalId.trim() : undefined;
}

function voucherRecordFromVoucher(
  id: string,
  voucher: Voucher,
  voucherHash: string,
  createdAt: string,
  metadata?: Record<string, unknown>,
): StreamingVoucherRecord {
  return {
    id,
    sessionId: voucher.sessionId,
    nonce: voucher.nonce,
    amount: voucher.amount,
    recipient: voucher.recipient,
    voucherHash,
    signature: voucher.signature,
    issuedAt: new Date(voucher.issuedAt).toISOString(),
    createdAt,
    ...(metadata ? { metadata: sanitizeSessionMetadata(metadata) as WorkflowJsonObject } : {}),
    voucher: clone(voucher),
  };
}

function isExpired(session: SessionGrant, now: Date): boolean {
  return Date.parse(session.expiresAt) <= now.getTime();
}

function secondsUntil(iso: string, now: Date): number {
  return Math.max(0, Math.floor((Date.parse(iso) - now.getTime()) / 1000));
}

function notFound(sessionId: string): StreamingServiceError {
  return new StreamingServiceError(404, 'session_not_found', `No streaming session found for id ${sessionId}.`);
}

function sessionSettlementEligible(session: StoredStreamingSession, now: Date, thresholdBps: number): boolean {
  if (isExpired(session, now) || session.status === 'revoked') return true;
  const decimals = session.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const spent = parseTokenAmountToBaseUnits(session.spentAmount, decimals, {
    allowZero: true,
    field: 'spentAmount',
  });
  const cap = parseTokenAmountToBaseUnits(session.capAmount, decimals, { field: 'capAmount' });
  return spent * 10_000n >= cap * BigInt(thresholdBps);
}

function isTerminalForSettlement(session: StoredStreamingSession, now: Date): boolean {
  if (isExpired(session, now) || session.status === 'revoked' || session.status === 'expired') return true;
  const decimals = session.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const spent = parseTokenAmountToBaseUnits(session.spentAmount, decimals, {
    allowZero: true,
    field: 'spentAmount',
  });
  const cap = parseTokenAmountToBaseUnits(session.capAmount, decimals, { field: 'capAmount' });
  return spent >= cap;
}

function settlementLockActive(session: StoredStreamingSession, now: Date): boolean {
  const lock = session.metadata?.[SESSION_LOCK_METADATA_KEY];
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return false;
  const expiresAt = (lock as Record<string, unknown>).expiresAt;
  return typeof expiresAt === 'string' && Date.parse(expiresAt) > now.getTime();
}

interface EncryptedDelegateKey {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
  tag: string;
}

interface DelegateKeyPayload {
  publicKey: string;
  secretKeyBase64: string;
}

function encryptDelegateKey(payload: DelegateKeyPayload): EncryptedDelegateKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', streamingEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptDelegateKey(payload: EncryptedDelegateKey): DelegateKeyPayload {
  if (payload.v !== 1 || payload.alg !== 'aes-256-gcm') {
    throw new StreamingServiceError(409, 'delegate_key_unsupported', 'Encrypted delegate key format is unsupported.');
  }
  const decipher = createDecipheriv('aes-256-gcm', streamingEncryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  const parsed = JSON.parse(decrypted.toString('utf8')) as Partial<DelegateKeyPayload>;
  if (!parsed.publicKey || !parsed.secretKeyBase64) {
    throw new StreamingServiceError(409, 'delegate_key_invalid', 'Encrypted delegate key payload is invalid.');
  }
  return { publicKey: parsed.publicKey, secretKeyBase64: parsed.secretKeyBase64 };
}

/**
 * Phase 5.2 — resolve and validate the streaming-session encryption master key.
 * Three accepted shapes:
 *   - Raw key (RECOMMENDED): base64-encoded 32-byte value. Generate via
 *     `openssl rand -base64 32`. Used verbatim — no entropy downgrade.
 *   - Passphrase (>=32 chars): SHA-256-hashed to 32 bytes. Logs a one-line
 *     warning on first read so operators notice the entropy downgrade.
 *   - Test mode (`NODE_ENV === 'test'` and env unset): deterministic test key.
 *
 * Refuses to return a key derived from a string shorter than 32 chars when
 * base64 decode also fails to yield 32 bytes — the previous behavior silently
 * hashed `STREAMING_SESSION_ENCRYPTION_KEY=changeme` to a "valid" 32-byte
 * digest with only ~64 bits of practical entropy.
 */
let warnedOnStreamingPassphrase = false;

export function streamingEncryptionKey(): Buffer {
  const configured = process.env.STREAMING_SESSION_ENCRYPTION_KEY?.trim();
  if (configured) {
    const base64 = (() => {
      try {
        return Buffer.from(configured, 'base64');
      } catch {
        return Buffer.alloc(0);
      }
    })();
    if (base64.length === 32) return base64;
    if (configured.length < 32) {
      throw new StreamingServiceError(
        500,
        'streaming_encryption_key_too_short',
        'STREAMING_SESSION_ENCRYPTION_KEY is too weak: provide a base64-encoded 32-byte raw key (recommended) or a passphrase of at least 32 characters. The previous silent SHA-256-of-short-passphrase behavior has been removed.',
      );
    }
    if (!warnedOnStreamingPassphrase) {
      warnedOnStreamingPassphrase = true;
      console.warn(
        '[streaming-service] STREAMING_SESSION_ENCRYPTION_KEY is being SHA-256-hashed from a passphrase. ' +
          'For maximum entropy, prefer a base64-encoded 32-byte raw key (`openssl rand -base64 32`).',
      );
    }
    return createHash('sha256').update(configured).digest();
  }
  if (process.env.NODE_ENV === 'test') {
    return createHash('sha256').update('agentic-streaming-test-key').digest();
  }
  throw new StreamingServiceError(
    500,
    'streaming_encryption_key_missing',
    'STREAMING_SESSION_ENCRYPTION_KEY is required for streaming session key storage.',
  );
}

// Test-only helper: reset the one-shot passphrase warning so unit tests can
// assert the warning fires on first read after a reconfigure.
export function __resetStreamingEncryptionKeyWarningForTests(): void {
  warnedOnStreamingPassphrase = false;
}

function envInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// postgresSslConfig (incl. env-driven TLS certificate verification) is centralized
// in postgresStore so the streaming pool and the workflow pool stay in lockstep.

interface StreamingSessionRow extends QueryResultRow {
  id: string;
  wallet_address: string;
  cluster: string;
  token_mint: string;
  delegate_pubkey: string;
  ephemeral_signer_pubkey: string;
  cap_amount: string;
  spent_amount: string;
  expires_at: Date | string;
  status: SessionGrant['status'];
  recipient_allowlist: unknown;
  approve_txid: string | null;
  revoke_txid: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  metadata: unknown;
}

interface StreamingCandidateRow extends StreamingSessionRow {
  unsettled_voucher_count: number | string;
}

interface StreamingVoucherRow extends QueryResultRow {
  id: string;
  session_id: string;
  nonce: string;
  amount: string;
  recipient: string;
  voucher_hash: string;
  signature: string;
  issued_at: Date | string;
  created_at: Date | string;
  settled_at: Date | string | null;
  settlement_txid: string | null;
  metadata: unknown;
}

function sessionFromRow(row: StreamingSessionRow | undefined): StoredStreamingSession {
  if (!row) throw new Error('Expected streaming session row.');
  const tokenDecimals = metadataTokenDecimals(row.metadata);
  return {
    sessionId: row.id,
    walletAddress: row.wallet_address,
    cluster: row.cluster as StreamingCluster,
    tokenMint: row.token_mint,
    delegatePubkey: row.delegate_pubkey,
    ephemeralSignerPubkey: row.ephemeral_signer_pubkey,
    capAmount: row.cap_amount,
    spentAmount: row.spent_amount,
    expiresAt: iso(row.expires_at),
    status: row.status,
    ...(tokenDecimals !== undefined ? { tokenDecimals } : {}),
    ...(recipientAllowlistFromDb(row.recipient_allowlist).length
      ? { recipientAllowlist: recipientAllowlistFromDb(row.recipient_allowlist) }
      : {}),
    ...(row.approve_txid ? { approveTxid: row.approve_txid } : {}),
    ...(row.revoke_txid ? { revokeTxid: row.revoke_txid } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(metadataFromDb(row.metadata) ? { metadata: metadataFromDb(row.metadata) as WorkflowJsonObject } : {}),
  };
}

function voucherFromRow(row: StreamingVoucherRow): StreamingVoucherRecord {
  const voucher: Voucher = {
    schema: STREAMING_VOUCHER_SCHEMA,
    sessionId: row.session_id,
    nonce: row.nonce,
    amount: row.amount,
    recipient: row.recipient,
    issuedAt: iso(row.issued_at),
    signature: row.signature,
  };
  return {
    id: row.id,
    sessionId: row.session_id,
    nonce: row.nonce,
    amount: row.amount,
    recipient: row.recipient,
    voucherHash: row.voucher_hash,
    signature: row.signature,
    issuedAt: iso(row.issued_at),
    createdAt: iso(row.created_at),
    ...(row.settled_at ? { settledAt: iso(row.settled_at) } : {}),
    ...(row.settlement_txid ? { settlementTxid: row.settlement_txid } : {}),
    ...(metadataFromDb(row.metadata) ? { metadata: metadataFromDb(row.metadata) as WorkflowJsonObject } : {}),
    voucher,
  };
}

function recipientAllowlistFromDb(value: unknown): string[] {
  const parsed = value ? jsonRecord<unknown>(value) : undefined;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function metadataFromDb(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (typeof metadata === 'string') return JSON.parse(metadata) as Record<string, unknown>;
  if (typeof metadata === 'object' && !Array.isArray(metadata)) return clone(metadata as Record<string, unknown>);
  return undefined;
}

function metadataTokenDecimals(metadata: unknown): number | undefined {
  const parsed = metadataFromDb(metadata);
  const value = parsed?.tokenDecimals;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function isStreamingStore(value: unknown): value is StreamingStore {
  return Boolean(value)
    && typeof (value as StreamingStore).createSession === 'function'
    && typeof (value as StreamingStore).acceptVoucher === 'function'
    && typeof (value as StreamingStore).listSettlementCandidates === 'function';
}

function pgClientFromStore(value: unknown): PgClient | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const client = (value as { client?: unknown }).client;
  return isPgClient(client) ? client : undefined;
}

function isPgClient(value: unknown): value is PgClient {
  return Boolean(value) && typeof (value as PgClient).query === 'function';
}

function shouldUseStandalonePostgres(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim()) && process.env.NODE_ENV !== 'test';
}

function isPgUniqueViolation(err: unknown, name: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const pgError = err as { code?: unknown; constraint?: unknown; message?: unknown; detail?: unknown };
  return pgError.code === '23505' &&
    (pgError.constraint === name || String(pgError.message ?? '').includes(name) || String(pgError.detail ?? '').includes(name));
}

function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function jsonRecord<T>(value: T | string): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return clone(value);
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
